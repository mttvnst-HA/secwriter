/**
 * createStorageFromEnv — build the configured storage backend from env vars.
 *
 * Extracted from collab-server.cjs's startFromEnv so the CLI entry-point and
 * operator tooling (server/migrate-tenant-namespace.cjs) construct the SAME
 * backend the server uses — previously the migration script hand-rolled its
 * own local-only fs logic and threw for s3/azure, leaving production
 * deployments with no supported relocation path.
 *
 * Selection via SIM_STORAGE_BACKEND: 'azure' | 's3' | anything else → local.
 * See ADR-0013 for the backend catalog and the per-backend env vars.
 *
 * CJS on purpose (see ADR-0001).
 */
'use strict';

const path = require('node:path');

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ storage: import('./room-storage.cjs').RoomStorageBase, backend: string, dataDir: string }}
 *   dataDir is always resolved (the local default) — only the local backend
 *   actually uses it, but callers (tmp sweep, log lines) read it uniformly.
 */
function createStorageFromEnv(env = process.env) {
  const dataDir = path.resolve(process.cwd(), env.SIM_LOCAL_STORAGE_DIR || 'server/collab-db');

  if (env.SIM_STORAGE_BACKEND === 'azure') {
    const { BlobServiceClient } = require('@azure/storage-blob');
    const { DefaultAzureCredential } = require('@azure/identity');
    const connectionString = env.SIM_AZURE_STORAGE_CONNECTION_STRING;
    const containerName = env.SIM_AZURE_STORAGE_CONTAINER || 'sim-collab-rooms';
    let blobServiceClient;
    if (connectionString) {
      blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    } else {
      const accountUrl = env.SIM_AZURE_STORAGE_ACCOUNT_URL;
      if (!accountUrl) throw new Error('Azure storage requires SIM_AZURE_STORAGE_CONNECTION_STRING or SIM_AZURE_STORAGE_ACCOUNT_URL');
      blobServiceClient = new BlobServiceClient(accountUrl, new DefaultAzureCredential());
    }
    const { AzureStorageBackend } = require('./storage-azure.cjs');
    const storage = new AzureStorageBackend({ containerClient: blobServiceClient.getContainerClient(containerName) });
    return { storage, backend: 'azure', dataDir, detail: { container: containerName } };
  }

  if (env.SIM_STORAGE_BACKEND === 's3') {
    const { S3Client } = require('@aws-sdk/client-s3');
    const endpoint = env.SIM_S3_ENDPOINT;
    const region = env.SIM_S3_REGION || 'auto';
    const accessKeyId = env.SIM_S3_ACCESS_KEY_ID;
    const secretAccessKey = env.SIM_S3_SECRET_ACCESS_KEY;
    const bucket = env.SIM_S3_BUCKET || 'sim-collab-rooms';
    if (!endpoint) throw new Error('S3 storage requires SIM_S3_ENDPOINT (e.g. https://<account-id>.r2.cloudflarestorage.com)');
    if (!accessKeyId || !secretAccessKey) throw new Error('S3 storage requires SIM_S3_ACCESS_KEY_ID and SIM_S3_SECRET_ACCESS_KEY');
    const client = new S3Client({
      endpoint,
      region,
      credentials: { accessKeyId, secretAccessKey },
      forcePathStyle: true,
    });
    const { S3StorageBackend } = require('./storage-s3.cjs');
    const storage = new S3StorageBackend({ client, bucket });
    return { storage, backend: 's3', dataDir, detail: { bucket, endpoint } };
  }

  const { LocalStorageBackend } = require('./storage-local.cjs');
  const storage = new LocalStorageBackend(dataDir);
  return { storage, backend: 'local', dataDir, detail: { dir: dataDir } };
}

module.exports = { createStorageFromEnv };
