#!/usr/bin/env node
import { runNPACli } from "../generator/cli";

void runNPACli(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
