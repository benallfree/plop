#!/usr/bin/env node

import "tsx";
import ora from "ora";
import path from "node:path";
import Liftoff from "liftoff";
import minimist from "minimist";
import v8flags from "v8flags";
import interpret from "interpret";
import chalk from "chalk";
const args = process.argv.slice(2);
const argv = minimist(args);

import nodePlop from "node-plop";
import * as out from "./console-out.js";
import { combineBypassData } from "./bypass.js";
import { getBypassAndGenerator, handleArgFlags } from "./input-processing.js";

const Plop = new Liftoff({
  name: "plop",
  extensions: interpret.jsVariants,
  v8flags: v8flags,
});

const isInJest = process.env.NODE_ENV === "test";

const progressSpinner = ora({
  // Default is stderr
  stream: isInJest ? process.stdout : process.stderr,
  isEnabled: !isInJest && argv.progress !== false,
});

/**
 * The function to pass as the second argument to `Plop.execute`
 * @param env - This is passed implicitly
 * @param _ - Passed implicitly. Not needed, but allows for `passArgsBeforeDashes` to be explicitly passed
 * @param passArgsBeforeDashes - An opt-in `true` boolean that will allow merging of plop CLI API and generator API
 * @example
 * Plop.execute(env => run(env, undefined, true))
 *
 * !!!!!! WARNING !!!!!!
 * One of the reasons we default generator arguments as anything past `--` is a few reasons:
 * Primarily that there may be name-spacing issues when combining the arg order and named arg passing
 */
async function run(env, _, passArgsBeforeDashes) {
  const plopfilePath = env.configPath;

  // handle basic argument flags like --help, --version, etc
  handleArgFlags(env);

  // use base path from argv or env if any is present, otherwise set it to the plopfile directory
  const destBasePath = argv.dest || env.dest;
  let plop;
  try {
    plop = await nodePlop(plopfilePath, {
      destBasePath: destBasePath ? path.resolve(destBasePath) : undefined,
      force: argv.force === true || argv.f === true || false,
    });
  } catch (e) {
    console.error(
      chalk.red("[PLOP] ") + "Something went wrong with reading your plop file",
      e,
    );
    throw e;
  }
  const generators = plop.getGeneratorList();
  const generatorNames = generators.map((v) => v.name);
  const { generatorName, bypassArr, plopArgV } = getBypassAndGenerator(
    plop,
    passArgsBeforeDashes,
  );

  // look up a generator and run it with calculated bypass data
  const runGeneratorByName = (name) => {
    const generator = plop.getGenerator(name);
    const bypassData = combineBypassData(generator, bypassArr, plopArgV);
    return doThePlop(generator, bypassData);
  };

  // hmmmm, couldn't identify a generator in the user's input
  if (!generators.length) {
    // no generators?! there's clearly something wrong here
    throw new Error("No generator found in plopfile");
  } else if (!generatorName && generators.length === 1) {
    // only one generator in this plopfile... let's assume they
    // want to run that one!
    await runGeneratorByName(generatorNames[0]);
  } else if (!generatorName && generators.length > 1 && !bypassArr.length) {
    // more than one generator? we'll have to ask the user which
    // one they want to run.
    await out
      .chooseOptionFromList(generators, plop.getWelcomeMessage())
      .then(runGeneratorByName)
  } else if (generatorNames.includes(generatorName)) {
    // we have found the generator, run it!
    await runGeneratorByName(generatorName);
  } else {
    // we just can't make sense of your input... sorry :-(
    const fuzzyGenName = (generatorName + " " + args.join(" ")).trim();
    throw new Error('Could not find a generator for "' +
        fuzzyGenName +
        '"',
    );
  }
  return plop;
}

/////
// everybody to the plop!
//
function doThePlop(generator, bypassArr) {
  let failedActions = false;
  return generator
    .runPrompts(bypassArr)
    .then(async (answers) => {
      return answers;
    })
    .then((answers) => {
      const noMap = argv["show-type-names"] || argv.t;
      const onComment = (msg) => {
        progressSpinner.info(msg);
        progressSpinner.start();
      };
      const onSuccess = (change) => {
        let line = "";
        if (change.type) {
          line += ` ${out.typeMap(change.type, noMap)}`;
        }
        if (change.path) {
          line += ` ${change.path}`;
        }
        progressSpinner.succeed(line);
        progressSpinner.start();
      };
      const onFailure = (fail) => {
        let line = "";
        if (fail.type) {
          line += ` ${out.typeMap(fail.type, noMap)}`;
        }
        if (fail.path) {
          line += ` ${fail.path}`;
        }
        const errMsg = fail.error || fail.message;
        if (errMsg) {
          line += ` ${errMsg}`;
        }
        progressSpinner.fail(line);
        failedActions = true;
        progressSpinner.start();
      };
      progressSpinner.start();
      return generator
        .runActions(answers, { onSuccess, onFailure, onComment })
        .finally(() => {
          progressSpinner.stop();
          if (failedActions) throw new Error(`At least one action has failed.`);
        });
    })
}

export { Plop, run, progressSpinner };
