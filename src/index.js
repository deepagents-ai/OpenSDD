import { createRequire } from 'node:module';
import { initCommand } from './commands/init.js';
import { listCommand } from './commands/list.js';
import { installCommand } from './commands/install.js';
import { updateCommand } from './commands/update.js';
import { updateApplyCommand } from './commands/updateApply.js';
import { publishCommand } from './commands/publish.js';
import { statusCommand } from './commands/status.js';
import { validateCommand } from './commands/validate.js';
import { syncCommand } from './commands/sync.js';
import { setupCiCommand } from './commands/setupCi.js';

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        flags[key] = argv[i + 1];
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(argv[i]);
    }
  }
  return { flags, positional };
}

function printHelp() {
  const require = createRequire(import.meta.url);
  const pkg = require('../package.json');
  console.log(`opensdd v${pkg.version} - Open Spec-Driven Development CLI

Usage: opensdd <command> [options]

Commands:
  init                    Initialize OpenSDD in the current project
  sync                    Update installed skill files and gate rules
  list                    List specs available in the registry
  install <name> [ver]    Install a spec from the registry
  update [name]           Fetch latest version of dependency specs
  update apply [name]     Apply a staged update to opensdd.json
  publish                 Publish an authored spec to the registry
  status                  Show status of authored and installed specs
  validate [path]         Validate a spec directory
  setup-ci                Set up GitHub Actions CI for spec-driven implementation

Options:
  --registry <url>        Alternative registry source
  --skill                 Install as an agent skill instead of a full spec
  --branch <name>         Branch name for publish PR
  --force                 Overwrite existing files/secrets without prompting (setup-ci)
  --dry-run               Print what would be done without making changes (setup-ci)
  --skip-token            Skip Claude OAuth token step (setup-ci)
  --version               Show version
  --help                  Show help`);
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const command = rawArgs[0];

  try {
    switch (command) {
      case 'init':
        await initCommand();
        break;

      case 'sync':
        await syncCommand();
        break;

      case 'list': {
        const { flags } = parseArgs(rawArgs.slice(1));
        await listCommand({ registry: flags.registry });
        break;
      }

      case 'install': {
        const { flags, positional } = parseArgs(rawArgs.slice(1));
        if (!positional[0]) {
          console.error('Usage: opensdd install <name> [version]');
          process.exit(1);
        }
        await installCommand(positional[0], positional[1], { registry: flags.registry, skill: flags.skill });
        break;
      }

      case 'update': {
        if (rawArgs[1] === 'apply') {
          const { positional } = parseArgs(rawArgs.slice(2));
          await updateApplyCommand(positional[0]);
        } else {
          const { flags, positional } = parseArgs(rawArgs.slice(1));
          await updateCommand(positional[0], { registry: flags.registry });
        }
        break;
      }

      case 'publish': {
        const { flags } = parseArgs(rawArgs.slice(1));
        await publishCommand({ branch: flags.branch, registry: flags.registry });
        break;
      }

      case 'status':
        await statusCommand();
        break;

      case 'validate': {
        const { positional } = parseArgs(rawArgs.slice(1));
        await validateCommand(positional[0]);
        break;
      }

      case 'setup-ci': {
        const { flags } = parseArgs(rawArgs.slice(1));
        await setupCiCommand({
          force: flags.force === true,
          dryRun: flags['dry-run'] === true,
          skipToken: flags['skip-token'] === true,
        });
        break;
      }

      case '--version':
      case '-v': {
        const require = createRequire(import.meta.url);
        const pkg = require('../package.json');
        console.log(pkg.version);
        break;
      }

      case '--help':
      case '-h':
      case undefined:
        printHelp();
        break;

      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
