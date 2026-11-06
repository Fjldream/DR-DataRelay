#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { issueLicense, inspectLicense } from './license-authority.mjs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function args(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) result._.push(value);
    else result[value.slice(2)] = argv[index + 1]?.startsWith('--') ? true : argv[++index];
  }
  return result;
}

function required(options, name) {
  const value = options[name];
  if (!value || value === true) fail(`缺少参数 --${name}`);
  return value;
}

function privateKeyPassphrase() {
  if (process.env.LICENSE_KEY_PASSPHRASE) return process.env.LICENSE_KEY_PASSPHRASE;
  if (process.env.LICENSE_KEY_PASSPHRASE_FILE) return fs.readFileSync(path.resolve(process.env.LICENSE_KEY_PASSPHRASE_FILE), 'utf8').trim();
  return null;
}

function keygen(options) {
  const output = path.resolve(required(options, 'output'));
  const keyId = options['key-id'] || `prod-${new Date().getUTCFullYear()}-01`;
  const generatedPassphrase = options['create-passphrase-file'] ? crypto.randomBytes(24).toString('base64url') : null;
  const passphrase = privateKeyPassphrase() || generatedPassphrase;
  if (!passphrase || passphrase.length < 12) fail('请通过 LICENSE_KEY_PASSPHRASE 设置至少 12 位私钥口令，或使用 --create-passphrase-file true');
  fs.mkdirSync(output, { recursive: true });
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase });
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
  const privateFile = path.join(output, `${keyId}.private.pem`);
  const publicFile = path.join(output, 'license-public-keys.json');
  fs.writeFileSync(privateFile, privatePem, { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(publicFile, `${JSON.stringify({ keys: { [keyId]: publicPem } }, null, 2)}\n`, { flag: 'wx' });
  const passphraseFile = generatedPassphrase ? path.join(output, 'PRIVATE_KEY_PASSPHRASE.txt') : null;
  if (passphraseFile) fs.writeFileSync(passphraseFile, `${generatedPassphrase}\n`, { mode: 0o600, flag: 'wx' });
  console.log(JSON.stringify({ keyId, privateKey: privateFile, publicKeys: publicFile, passphraseFile }, null, 2));
}

function generate(options) {
  const passphrase = privateKeyPassphrase();
  if (!passphrase) fail('请通过 LICENSE_KEY_PASSPHRASE 或 LICENSE_KEY_PASSPHRASE_FILE 提供私钥口令');
  const privateFile = path.resolve(required(options, 'private-key'));
  const output = path.resolve(required(options, 'output'));
  try {
    const result = issueLicense({
      privateKeyFile: privateFile,
      passphrase,
      customer: required(options, 'customer'),
      project: required(options, 'project'),
      machineCode: required(options, 'machine-code'),
      maxDevices: required(options, 'max-devices'),
      validFrom: required(options, 'valid-from'),
      validUntil: required(options, 'valid-until'),
      outputDir: output,
      ledgerFile: path.join(output, 'issued-licenses.db'),
      keyId: options['key-id'],
      note: options.note,
      licenseId: options['license-id'],
    });
    console.log(JSON.stringify({ ...result.payload, licenseFile: result.licenseFile, activationCode: result.activationCode }, null, 2));
  } catch (error) { fail(error.message); }
}

function inspect(options) {
  const code = options.file ? fs.readFileSync(path.resolve(options.file), 'utf8').trim() : required(options, 'code');
  console.log(JSON.stringify(inspectLicense({ code, publicKeysFile: required(options, 'public-keys') }), null, 2));
}

const options = args(process.argv.slice(2));
const command = options._[0];
if (command === 'keygen') keygen(options);
else if (command === 'generate') generate(options);
else if (command === 'inspect') inspect(options);
else fail(`用法：
  license-generator keygen --output <目录> [--key-id prod-2026-01] [--create-passphrase-file true]
  license-generator generate --private-key <pem> --customer <客户> --project <项目> --machine-code <DRM-...> --max-devices <数量> --valid-from <日期> --valid-until <日期> --output <目录>
  license-generator inspect --file <lic> --public-keys <json>`);
