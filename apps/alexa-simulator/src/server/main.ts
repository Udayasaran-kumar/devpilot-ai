import { configFromEnvironment } from './config.js';
import { describeError, startSimulator } from './simulator.js';

async function main(): Promise<void> {
  try {
    const config = configFromEnvironment(process.env);
    const simulator = await startSimulator(config, { onError: (error) => console.error(`[alexa-simulator] ${describeError(error)}`) });
    console.log(`DevPilot Alexa+ style simulation at http://localhost:${simulator.url.port}/`);
    console.log((await simulator.available()) ? 'The DevPilot MCP server is reachable.' : 'The DevPilot MCP server is not reachable yet.');
    const shutdown = () => {
      simulator.close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    console.error(`[alexa-simulator] ${describeError(error)}`);
    process.exitCode = 1;
  }
}

await main();
