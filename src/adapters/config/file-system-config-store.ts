import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  LocalSettings,
  LocalDevSecretStore,
  SettingsStore,
  SecretMetadata,
} from "../../domain/config/index.js";
import { renameWithRetry } from "../../kernel/fs/atomic-write.js";
import { asRecord, isFileNotFound, stringOrUndefined } from "../../kernel/values/index.js";

type LocalDevSecretsFile = {
  readonly version: 1;
  readonly secrets: Readonly<Record<string, { readonly value: string; readonly updatedAt: string }>>;
  readonly updatedAt: string;
};

export class FileSystemSettingsStore implements SettingsStore {
  readonly settingsPath: string;

  constructor(readonly configDirectory: string) {
    this.settingsPath = path.join(configDirectory, "settings.json");
  }

  readSettings(): Promise<unknown | undefined> {
    return readJsonFile(this.settingsPath);
  }

  async writeSettings(settings: LocalSettings): Promise<void> {
    await writeJsonFileAtomically(this.settingsPath, settings);
  }
}

export class FileSystemLocalDevSecretStore implements LocalDevSecretStore {
  readonly secretsPath: string;

  constructor(readonly configDirectory: string) {
    this.secretsPath = path.join(configDirectory, "local-dev-secrets.json");
  }

  async getMetadata(secretRef: string): Promise<SecretMetadata> {
    const secrets = await this.readSecretsFile();
    const entry = secrets.secrets[secretRef];
    return entry === undefined ? { configured: false } : { configured: true, updatedAt: entry.updatedAt };
  }

  async readSecret(secretRef: string): Promise<string | undefined> {
    const secrets = await this.readSecretsFile();
    return secrets.secrets[secretRef]?.value;
  }

  async writeSecret(secretRef: string, value: string): Promise<SecretMetadata> {
    const current = await this.readSecretsFile();
    const updatedAt = new Date().toISOString();
    const next: LocalDevSecretsFile = {
      version: 1,
      secrets: {
        ...current.secrets,
        [secretRef]: { value, updatedAt },
      },
      updatedAt,
    };
    await writeJsonFileAtomically(this.secretsPath, next);
    return { configured: true, updatedAt };
  }

  async deleteSecret(secretRef: string): Promise<SecretMetadata> {
    const current = await this.readSecretsFile();
    if (current.secrets[secretRef] === undefined) {
      return { configured: false };
    }
    const updatedAt = new Date().toISOString();
    const remainingSecrets = Object.fromEntries(
      Object.entries(current.secrets).filter(([candidateRef]) => candidateRef !== secretRef)
    );
    const next: LocalDevSecretsFile = {
      version: 1,
      secrets: remainingSecrets,
      updatedAt,
    };
    await writeJsonFileAtomically(this.secretsPath, next);
    return { configured: false };
  }

  private async readSecretsFile(): Promise<LocalDevSecretsFile> {
    const raw = await readJsonFile(this.secretsPath);
    if (raw === undefined) {
      return { version: 1, secrets: {}, updatedAt: new Date(0).toISOString() };
    }
    return parseSecretsFile(raw);
  }
}

async function readJsonFile(filePath: string): Promise<unknown | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (isFileNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

async function writeJsonFileAtomically(filePath: string, value: unknown): Promise<void> {
  const directory = path.dirname(filePath);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  const payload = `${JSON.stringify(value, null, 2)}\n`;

  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(tempPath, payload, { encoding: "utf8", mode: 0o600 });
    await renameWithRetry(tempPath, filePath, { backoffMs: renameBackoffMs });
  } catch (error) {
    try {
      await fs.rm(tempPath, { force: true });
    } catch {
      // Keep the original persistence failure visible to the caller.
    }
    throw error;
  }
}

function renameBackoffMs(attempt: number): number {
  // 指数退避：~10ms, 20ms, 40ms, 80ms, 160ms（封顶 200ms），总等待 <500ms。
  return Math.min(10 * 2 ** attempt, 200);
}

function parseSecretsFile(raw: unknown): LocalDevSecretsFile {
  const record = asRecord(raw);
  const rawSecrets = asRecord(record.secrets);
  const secrets: Record<string, { value: string; updatedAt: string }> = {};
  for (const [secretRef, secret] of Object.entries(rawSecrets)) {
    const secretRecord = asRecord(secret);
    const value = stringOrUndefined(secretRecord.value);
    const updatedAt = stringOrUndefined(secretRecord.updatedAt);
    if (value !== undefined && updatedAt !== undefined) {
      secrets[secretRef] = { value, updatedAt };
    }
  }
  return {
    version: 1,
    secrets,
    updatedAt: stringOrUndefined(record.updatedAt) ?? new Date(0).toISOString(),
  };
}
