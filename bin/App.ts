#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { FileDropStack as FileDropStack } from '../lib/Stack';
import { IContext } from '../context/IContext';

const app = new cdk.App();
const context = require('../context/context.json') as IContext;

const {
  STACK_ID,
  ACCOUNT: account,
  REGION: region,
  TAGS: {
    Landscape,
    CostCenter = '',
    Ticket = '',
    Service,
    Function
  }
} = context;

const stackName = `${STACK_ID}-${Landscape}`;

new FileDropStack(app, 'file-drop-stack', {
  context,
  stackProps: {
    stackName,
    description: 'S3 bucket and event processor for async file drop and processing by target Lambda functions',
    env: { account, region },
    tags: { Landscape, CostCenter, Ticket, Service, Function }
  }
});

app.synth();
