import type { DialogClient } from '../../../voice-demo/src/dialog.js';
import { DevPilotMcpClient, type DevPilotMcpClientOptions } from '../../../voice-demo/src/mcp-client.js';

/**
 * The simulator's one `DevPilotMcpClient`, connected on first use so the
 * simulator can start before the MCP server. A failed connection attempt is
 * retried on the next call; once connected, the client reconnects itself.
 */
export class McpConnection implements DialogClient {
  readonly #options: DevPilotMcpClientOptions;
  #client: Promise<DevPilotMcpClient> | undefined;
  #status: Promise<boolean> | undefined;

  constructor(options: DevPilotMcpClientOptions) {
    this.#options = options;
  }

  listRepositories(): ReturnType<DevPilotMcpClient['listRepositories']> {
    return this.#use((client) => client.listRepositories());
  }

  startInvestigation(repositoryId: string): ReturnType<DevPilotMcpClient['startInvestigation']> {
    return this.#use((client) => client.startInvestigation(repositoryId));
  }

  getInvestigationResult(jobId: string): ReturnType<DevPilotMcpClient['getInvestigationResult']> {
    return this.#use((client) => client.getInvestigationResult(jobId));
  }

  /** Whether the MCP server answers `list_repositories`; concurrent checks share one call. */
  available(): Promise<boolean> {
    this.#status ??= this.listRepositories()
      .then(
        () => true,
        () => false,
      )
      .finally(() => {
        this.#status = undefined;
      });
    return this.#status;
  }

  async close(): Promise<void> {
    const pending = this.#client;
    this.#client = undefined;
    const client = await pending?.catch(() => undefined);
    await client?.close();
  }

  async #use<T>(call: (client: DevPilotMcpClient) => Promise<T>): Promise<T> {
    this.#client ??= DevPilotMcpClient.connect(this.#options).catch((error: unknown) => {
      this.#client = undefined;
      throw error;
    });
    return call(await this.#client);
  }
}
