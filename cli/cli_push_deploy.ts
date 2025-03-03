import { Bytes } from '../common/bytes.ts';
import { Binding, isSecretBinding, isTextBinding } from '../common/config.ts';
import { isValidScriptName } from '../common/config_validation.ts';
import { bundle, commandOptionsForBundle, parseBundleOpts } from './bundle.ts';
import { commandOptionsForInputBindings, computeContentsForScriptReference, denoflareCliCommand, parseInputBindingsFromOptions, replaceImports } from './cli_common.ts';
import { commandOptionsForConfigOnly, loadConfig, resolveBindings } from './config_loader.ts';
import { DeployRequest, LogQueryRequestParams, deploy, getLogs, listProjects, negotiateAssets, queryLogs, setEnvironmentVariables } from '../common/deploy/deno_deploy_api.ts';
import { isAbsolute, resolve } from './deps_cli.ts';
import { ModuleWatcher } from './module_watcher.ts';
import { setEqual } from '../common/sets.ts';
import { mapValues } from 'https://deno.land/std@0.201.0/collections/map_values.ts';

export const PUSH_DEPLOY_COMMAND = denoflareCliCommand('push-deploy', 'Upload a Cloudflare worker script to Deno Deploy')
    .arg('scriptSpec', 'string', 'Name of script defined in .denoflare config, file path to bundled js worker, or an https url to a module-based worker .ts, e.g. https://path/to/worker.ts')
    .option('name', 'string', `Project name in Deno Deploy [default: Name of script defined in .denoflare config, or https url basename sans extension]`)
    .option('accessToken', 'string', 'Personal access token from the Deploy dashboard  (or set DENO_DEPLOY_TOKEN env var)')
    .option('watch', 'boolean', 'If set, watch the local file system and automatically re-upload on script changes')
    .option('watchInclude', 'strings', 'If watching, watch this additional path as well (e.g. for dynamically-imported static resources)', { hint: 'path' })
    .option('getLogs', 'boolean', '')
    .option('queryLogs', 'boolean', '')
    .include(commandOptionsForInputBindings)
    .include(commandOptionsForConfigOnly)
    .include(commandOptionsForBundle)
    .docsLink('/cli/push-deploy')
    ;

export async function pushDeploy(args: (string | number)[], options: Record<string, unknown>) {
    if (PUSH_DEPLOY_COMMAND.dumpHelp(args, options)) return;

    const opt = PUSH_DEPLOY_COMMAND.parse(args, options);
    const { scriptSpec, verbose, name: nameOpt, accessToken: accessTokenOpt, watch, watchInclude, getLogs: getLogsOpt, queryLogs: queryLogsOpt } = opt;

    if (verbose) {
        // in cli
        ModuleWatcher.VERBOSE = verbose;
    }

    const config = await loadConfig(options);
    const { scriptName, rootSpecifier, script } = await computeContentsForScriptReference(scriptSpec, config, nameOpt);
    if (!isValidScriptName(scriptName)) throw new Error(`Bad scriptName: ${scriptName}`);
    const inputBindings = { ...(script?.bindings || {}), ...parseInputBindingsFromOptions(options) };
    const bundleOpts = parseBundleOpts(options);
    const { accessToken } = (() => {
        const { deploy } = script ?? {};
        const configOpts: Record<string, string> = {};
        if (deploy) {
            for (const token of deploy.trim().split(',')) {
                const m = /^([a-z-]+)=(.+?)$/.exec(token.trim());
                if (!m) throw new Error(`Invalid deploy config: ${deploy}`);
                const [ _, name, value ] = m;
                configOpts[name] = value;
            }
        }
        const accessToken = accessTokenOpt ?? configOpts['access-token'] ?? Deno.env.get('DENO_DEPLOY_TOKEN');
        return { accessToken };
    })();
    if (accessToken === undefined) throw new Error(`Provide access token for deploying the worker via either --access-token, in config, or DENO_DEPLOY_TOKEN env var`);

    const pushStart = new Date().toISOString().substring(0, 19) + 'Z';
    let pushNumber = 1;

    const buildAndPutScript = async () => {
        const isModule = !rootSpecifier.endsWith('.js');
        let scriptContentsStr = '';
        if (isModule) {
            console.log(`bundling ${scriptName} into bundle.js...`);
            const start = Date.now();
            const output = await bundle(rootSpecifier, bundleOpts);
            scriptContentsStr = output.code;
            console.log(`bundle finished (${output.backend}) in ${Date.now() - start}ms`);
        } else {
            scriptContentsStr = await Deno.readTextFile(rootSpecifier);
        }

        let start = Date.now();
        const pushId = watch ? `${pushStart}.${pushNumber}` : undefined;
        const pushIdSuffix = pushId ? ` ${pushId}` : '';
        const environmentVariables = await computeEnvironmentVariables(inputBindings, pushId);

        const allFiles = new Map<string, FileEntry>();

        const addFile = async (name: string, bytes: Bytes) => {
            allFiles.set(name, { size: bytes.length, bytes: bytes.array(), gitSha1: await bytes.gitSha1Hex() });
        }

        if (isModule) {
            scriptContentsStr = await rewriteScriptContents(scriptContentsStr, rootSpecifier, allFiles);
        }

        if (!isModule) throw new Error(`Only module-based workers are supported`);

        console.log(`pushing ${isModule ? 'module' : 'script'}-based deploy worker ${scriptName}${pushIdSuffix}...`);

        start = Date.now();

        const apiToken = accessToken;

        const projects = await listProjects({ apiToken });
        const project = projects.find(v => v.name === scriptName);
        if (!project) throw new Error(`Create a new empty Deno Deploy project named '${scriptName}' at https://dash.deno.com/projects`);
        const projectId = project.id;

        if (getLogsOpt) {
            const deploymentId = project.productionDeployment.deployment?.id;
            if (deploymentId === undefined) throw new Error(`No deployment found for project`);
            const iter = getLogs({ projectId, deploymentId, apiToken });
            for await (const log of iter) {
                console.log(JSON.stringify(log));
            }
            return;
        }
        if (queryLogsOpt) {
            const deploymentId = project.productionDeployment.deployment?.id;
            if (deploymentId === undefined) throw new Error(`No deployment found for project`);
            const params: LogQueryRequestParams = {};
            const { logs } = await queryLogs({ projectId, deploymentId, apiToken, params });
            for (const log of logs) {
                console.log(JSON.stringify(log));
            }
            return;
        }
        if (!setEqual(new Set(project.envVars), new Set(Object.keys(environmentVariables)))) {
            console.log('updating project environment variables');
            await setEnvironmentVariables({ projectId, variables: environmentVariables, apiToken });
        }

        const appTsBytes = new Bytes(new Uint8Array(await (await fetch(new URL('../common/deploy/deno_deploy_app.ts', import.meta.url))).arrayBuffer()));

        const workerTsBytes = Bytes.ofUtf8(scriptContentsStr);

        await addFile('app.ts', appTsBytes);
        await addFile('worker.ts', workerTsBytes);

        const request: DeployRequest = {
            url: 'file:///src/app.ts',
            importMapUrl: null,
            production: true,
            manifest: { entries: mapValues(Object.fromEntries(allFiles), ({ size, gitSha1 }) => ({ kind: 'file', size, gitSha1 })) },
        };

        const updatedHashes = await negotiateAssets({ projectId, apiToken, manifest: request.manifest! });
        const updatedFiles = [...allFiles.values()].filter(v => updatedHashes.includes(v.gitSha1)).map(v => v.bytes);
        console.log(`updatedFiles: ${updatedFiles.length}`);
        for await (const message of deploy({ projectId, apiToken, request, files: updatedFiles })) {
            console.log(JSON.stringify(message));
        }

        console.log(`deployed worker to ${scriptName} in ${Date.now() - start}ms`);
        
        pushNumber++;
    }
    await buildAndPutScript();

    if (watch) {
        console.log('watching for changes...');
        const scriptUrl = rootSpecifier.startsWith('https://') ? new URL(rootSpecifier) : undefined;
        if (scriptUrl && !scriptUrl.pathname.endsWith('.ts')) throw new Error('Url-based module workers must end in .ts');
        const scriptPathOrUrl = scriptUrl ? scriptUrl.toString() : script ? script.path : isAbsolute(rootSpecifier) ? rootSpecifier : resolve(Deno.cwd(), rootSpecifier);
        const _moduleWatcher = new ModuleWatcher(scriptPathOrUrl, async () => {
            try {
                await buildAndPutScript();
            } catch (e) {
                console.error(e);
            } finally {
                console.log('watching for changes...');
            }
        }, watchInclude);
        return new Promise(() => {});
    }
}

//

type FileEntry = { size: number, bytes: Uint8Array, gitSha1: string };

async function rewriteScriptContents(scriptContents: string, rootSpecifier: string, allFiles: Map<string, FileEntry>): Promise<string> {
    return await replaceImports(scriptContents, rootSpecifier, async ({ valueBytes: bytes, line, importMetaVariableName, unquotedModuleSpecifier }) => {
        const gitSha1 = await new Bytes(bytes).gitSha1Hex();
        const size = bytes.length;
        const filename = `_import_${gitSha1}.dat`;
        allFiles.set(filename, { bytes, gitSha1, size });
        return line.replace(importMetaVariableName, 'import.meta').replace(unquotedModuleSpecifier, `./${filename}`);
    });
}

async function computeEnvironmentVariables(inputBindings: Record<string, Binding>, pushId: string | undefined): Promise<Record<string, string>> {
    const resolvedBindings = await resolveBindings(inputBindings, { pushId });
    const rt: Record<string, string> = {};
    for (const [ name, binding ] of Object.entries(resolvedBindings)) {
        if (isTextBinding(binding)) {
            rt[name] = binding.value;
        } else if (isSecretBinding(binding)) {
            rt[name] = binding.secret;
        } else {
            throw new Error(`Env binding not supported on Deploy: ${JSON.stringify(binding)}`);
        }
    }
    return rt;
}
