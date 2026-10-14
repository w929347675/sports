import { randomBytes } from 'node:crypto';
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { modelSettingsInputSchema, modelSettingsSchema } from '@fitness-coach/shared';
import { AiClientError, requestChatCompletion, type AiConfig, type AiRequestOptions } from '@fitness-coach/ai';
import { ApiError, configurationError } from '../errors.js';
import type { ServiceContext } from './context.js';

function response(settings: { base_url?: string; model_name?: string }, configured: boolean) {
  const data: { baseUrl?: string; modelName?: string; configured: boolean } = {
    configured,
  };
  if (settings.base_url) data.baseUrl = settings.base_url;
  if (settings.model_name) data.modelName = settings.model_name;
  return modelSettingsSchema.parse(data);
}

const secretFilename = 'model-api-key.secret';

type SettingsDependencies = {
  tester?: (config: AiConfig, options?: AiRequestOptions) => Promise<void>;
};

export function createSettingsService({ repositories, dataDir }: ServiceContext, dependencies: SettingsDependencies = {}) {
  const secretPath = join(dataDir, secretFilename);

  async function readSecret() {
    try {
      const value = (await readFile(secretPath, 'utf8')).trim();
      return value || undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      configurationError('Unable to read model configuration');
    }
  }

  async function writeSecret(value: string, target = secretPath) {
    const temporaryPath = `${target}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temporaryPath, value, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, target);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      configurationError('Unable to save model configuration');
    }
  }

  return {
    async getModel() {
      return response(repositories.settings.getModel(), Boolean(await readSecret()));
    },
    async getModelCredentials() {
      const model = repositories.settings.getModel();
      const apiKey = await readSecret();
      if (!model.base_url || !model.model_name || !apiKey) {
        configurationError('Model configuration is incomplete');
      }
      return { baseUrl: model.base_url, modelName: model.model_name, apiKey };
    },
    async testConnection() {
      const credentials = await this.getModelCredentials();
      const tester = dependencies.tester ?? (async (config: AiConfig) => {
        await requestChatCompletion(config, [
          { role: 'system', content: 'Return a JSON object with a single connected boolean.' },
          { role: 'user', content: 'Connection test. Return {"connected":true}.' },
        ], { timeoutMs: 60_000 });
      });
      try {
        await tester(credentials, { timeoutMs: 60_000 });
      } catch (error) {
        if (error instanceof AiClientError) {
          throw new ApiError(error.code, 'Model connection failed', error.code === 'AI_AUTHENTICATION_FAILED' ? 502 : 503);
        }
        throw error;
      }
      return { connected: true, modelName: credentials.modelName };
    },
    async saveModel(input: unknown) {
      const parsed = modelSettingsInputSchema.parse(input);
      const previous = repositories.settings.getModel();
      const previousSecret = await readSecret();
      const stagedSecret = `${secretPath}.${randomBytes(8).toString('hex')}.staged`;
      await writeSecret(parsed.api_key, stagedSecret);
      try {
        const saved = repositories.settings.saveModel({ base_url: parsed.base_url, model_name: parsed.model_name });
        await rename(stagedSecret, secretPath);
        return response(saved, true);
      } catch (error) {
        await rm(stagedSecret, { force: true });
        try {
          if (previous.base_url && previous.model_name) repositories.settings.saveModel({ base_url: previous.base_url, model_name: previous.model_name });
          else repositories.settings.clearModel();
          if (previousSecret) await writeSecret(previousSecret);
          else await rm(secretPath, { force: true });
        } catch {
          configurationError('Unable to restore model configuration');
        }
        throw error;
      }
    },
    async clearModelKey() {
      try {
        await rm(secretPath, { force: true });
      } catch {
        configurationError('Unable to clear model configuration');
      }
      return response(repositories.settings.getModel(), false);
    },
  };
}
