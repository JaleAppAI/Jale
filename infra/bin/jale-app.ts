#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { buildJaleApp } from '../lib/app-composition';

// Entry point only. Every stack and every wire lives in
// `lib/app-composition.ts` so that tests can synthesize the REAL app rather
// than a hand-rolled subset of it — see the note there.
const app = new cdk.App();
buildJaleApp(app);
