import { denoflareCliCommand } from './cli_common.ts';
import { commandOptionsForConfig, loadConfig, resolveProfile } from './config_loader.ts';
import { CloudflareApi, createD1Backup, createD1Database, deleteD1Database, downloadD1Backup, listD1Backups, listD1Databases, queryD1Database, restoreD1Backup } from '../common/cloudflare_api.ts';
import { checkEqual } from '../common/check.ts';
import { Bytes } from '../common/bytes.ts';
import { normalize } from './deps_cli.ts';
import { join } from './deps_cli.ts';

export const LIST_COMMAND = denoflareCliCommand(['d1', 'list'], `List databases`)
    .include(commandOptionsForConfig)
    .docsLink('/cli/d1#list')
    ;

export const DROP_COMMAND = denoflareCliCommand(['d1', 'drop'], `Drop a database`)
    .arg('databaseName', 'string', 'Name of the database to drop')
    .include(commandOptionsForConfig)
    .docsLink('/cli/d1#drop')
    ;

export const CREATE_COMMAND = denoflareCliCommand(['d1', 'create'], `Create a database`)
    .arg('databaseName', 'string', 'Name of the database to create')
    .option('location', 'enum', `Hint for the database's primary location`, ...Object.entries({ weur: 'Western Europe', eeur: 'Eastern Europe', apac: 'Asia Pacific', wnam: 'Western North America', enam: 'Eastern North America' }).map(v => ({ value: v[0], description: v[1] })))
    .option('experimentalBackend', 'boolean', 'Use the new experimental database backend')
    .include(commandOptionsForConfig)
    .docsLink('/cli/d1#create')
    ;

export const QUERY_COMMAND = denoflareCliCommand(['d1', 'query'], `Query a database`)
    .arg('databaseName', 'string', 'Name of the database to query')
    .option('sql', 'string', 'SQL query to execute')
    .option('param', 'strings', 'Ordinal parameters for the query', { hint: 'value' })
    .include(commandOptionsForConfig)
    .docsLink('/cli/d1#query')
    ;

export const BACKUP_COMMAND = denoflareCliCommand(['d1', 'backup'], `Backup a database`)
    .arg('databaseName', 'string', 'Name of the database to backup')
    .include(commandOptionsForConfig)
    .docsLink('/cli/d1#backup')
    ;

export const LIST_BACKUPS_COMMAND = denoflareCliCommand(['d1', 'list-backups'], `List all backups for a database`)
    .arg('databaseName', 'string', 'Name of the database')
    .include(commandOptionsForConfig)
    .docsLink('/cli/d1#list-backups')
    ;

export const RESTORE_COMMAND = denoflareCliCommand(['d1', 'restore'], `Restore a database from a previous backup`)
    .arg('databaseName', 'string', 'Name of the database to backup')
    .option('backupId', 'required-string', 'Uuid of the backup to restore')
    .include(commandOptionsForConfig)
    .docsLink('/cli/d1#restore')
    ;

export const DOWNLOAD_COMMAND = denoflareCliCommand(['d1', 'download'], `Download a database as a sqlite3 db file`)
    .arg('databaseName', 'string', 'Name of the database to download')
    .option('file', 'required-string', 'Local file path at which to save the sqlite db file')
    .option('backupId', 'string', 'Uuid of the backup to download (default: take a new backup and download that)')
    .include(commandOptionsForConfig)
    .docsLink('/cli/d1#download')
    ;

export const D1_COMMAND = denoflareCliCommand('d1', 'Manage and query your Cloudflare D1 databases')
    .subcommand(LIST_COMMAND, list)
    .subcommand(DROP_COMMAND, drop)
    .subcommand(CREATE_COMMAND, create)
    .subcommand(QUERY_COMMAND, query)
    .subcommandGroup()
    .subcommand(BACKUP_COMMAND, backup)
    .subcommand(RESTORE_COMMAND, restore)
    .subcommand(DOWNLOAD_COMMAND, download)
    .subcommand(LIST_BACKUPS_COMMAND, listBackups)

    .docsLink('/cli/d1')
    ;

export async function d1(args: (string | number)[], options: Record<string, unknown>): Promise<void> {
    await D1_COMMAND.routeSubcommand(args, options);
}

//

async function list(args: (string | number)[], options: Record<string, unknown>): Promise<void> {
    if (LIST_COMMAND.dumpHelp(args, options)) return;

    const { verbose } = LIST_COMMAND.parse(args, options);
    if (verbose) CloudflareApi.DEBUG = true;
    const { accountId, apiToken } = await resolveProfile(await loadConfig(options), options);

    const dbs = await listD1Databases({ accountId, apiToken });
    console.log(dbs);
}

async function drop(args: (string | number)[], options: Record<string, unknown>): Promise<void> {
    if (DROP_COMMAND.dumpHelp(args, options)) return;

    const { verbose, databaseName } = DROP_COMMAND.parse(args, options);
    const { databaseUuid, accountId, apiToken } = await common(databaseName, verbose, options);

    await deleteD1Database({ accountId, apiToken, databaseUuid });
}

async function create(args: (string | number)[], options: Record<string, unknown>): Promise<void> {
    if (CREATE_COMMAND.dumpHelp(args, options)) return;

    const { verbose, databaseName, location, experimentalBackend } = CREATE_COMMAND.parse(args, options);
    if (verbose) CloudflareApi.DEBUG = true;
    const { accountId, apiToken } = await resolveProfile(await loadConfig(options), options);

    const db = await createD1Database({ accountId, apiToken, databaseName, location, experimentalBackend });
    console.log(db);
}

async function query(args: (string | number)[], options: Record<string, unknown>): Promise<void> {
    if (QUERY_COMMAND.dumpHelp(args, options)) return;

    const { verbose, databaseName, sql, param } = QUERY_COMMAND.parse(args, options);
    if (!sql) throw new Error(`Provide a query with --sql`);

    const { databaseUuid, accountId, apiToken } = await common(databaseName, verbose, options);

    const queryResults = await queryD1Database({ accountId, apiToken, databaseUuid, sql, params: param });
    console.log(JSON.stringify(queryResults, undefined, 2));
}

async function backup(args: (string | number)[], options: Record<string, unknown>): Promise<void> {
    if (BACKUP_COMMAND.dumpHelp(args, options)) return;

    const { verbose, databaseName } = BACKUP_COMMAND.parse(args, options);
    const { databaseUuid, accountId, apiToken } = await common(databaseName, verbose, options);

    const start = Date.now();
    const backup = await createD1Backup({ accountId, apiToken, databaseUuid });
    console.log(`Backup ${backup.id} (${Bytes.formatSize(backup.file_size)}) took ${Date.now() - start}ms`);
}

async function listBackups(args: (string | number)[], options: Record<string, unknown>): Promise<void> {
    if (BACKUP_COMMAND.dumpHelp(args, options)) return;

    const { verbose, databaseName } = BACKUP_COMMAND.parse(args, options);
    const { databaseUuid, accountId, apiToken } = await common(databaseName, verbose, options);

    const backups = await listD1Backups({ accountId, apiToken, databaseUuid });
    const sorted = [...backups].sort((a, b) =>  a.created_at.localeCompare(b.created_at));
    let prevDay: string | undefined;
    for (const backup of sorted) {
        checkEqual('backup.database_id', backup.database_id, databaseUuid);
        const time = backup.created_at.substring(0, `2022-07-02T00:37:22`.length);
        const day = time.substring(0, `2022-07-02`.length);
        if (prevDay && day !== prevDay) console.log();
        console.log(`${backup.id} ${time} state=${backup.state} tables=${backup.num_tables} size=${Bytes.formatSize(backup.file_size)}`);
        prevDay = day;
    }
    console.log(`${backups.length} backups`)
}

async function restore(args: (string | number)[], options: Record<string, unknown>): Promise<void> {
    if (RESTORE_COMMAND.dumpHelp(args, options)) return;

    const { verbose, databaseName, backupId: backupUuid } = RESTORE_COMMAND.parse(args, options);

    const { databaseUuid, accountId, apiToken } = await common(databaseName, verbose, options);

    const start = Date.now();
    await restoreD1Backup({ accountId, apiToken, databaseUuid, backupUuid });
    console.log(`Restore of backup ${backupUuid} took ${Date.now() - start}ms`);
}

async function download(args: (string | number)[], options: Record<string, unknown>): Promise<void> {
    if (DOWNLOAD_COMMAND.dumpHelp(args, options)) return;

    const { verbose, databaseName, backupId, file } = DOWNLOAD_COMMAND.parse(args, options);

    const { databaseUuid, accountId, apiToken } = await common(databaseName, verbose, options);

    const backupUuid = backupId ?? await (async () => {
        const start = Date.now();
        const backup = await createD1Backup({ accountId, apiToken, databaseUuid });
        console.log(`Backup ${backup.id} (${Bytes.formatSize(backup.file_size)}) took ${Date.now() - start}ms`);
        return backup.id;
    })();
    const start = Date.now();
    const bytes = await downloadD1Backup({ accountId, apiToken, databaseUuid, backupUuid });
    console.log(`Download of backup ${backupUuid} (${Bytes.formatSize(bytes.length)}) took ${Date.now() - start}ms`);

    await Deno.writeFile(file, bytes);
    console.log(`Saved to ${normalize(join(Deno.cwd(), file))}`);
}

//

async function common(databaseName: string, verbose: boolean, options: Record<string, unknown>): Promise<{ databaseUuid: string, accountId: string, apiToken: string }> {
    if (verbose) CloudflareApi.DEBUG = true;
    const { accountId, apiToken } = await resolveProfile(await loadConfig(options), options);

    const database = (await listD1Databases({ accountId, apiToken })).find(v => v.name === databaseName);
    if (!database) throw new Error(`Database not found: ${databaseName}`);
    const { uuid: databaseUuid } = database;

    return { databaseUuid, accountId, apiToken };
}
