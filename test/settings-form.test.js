'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { buildSync } = require('esbuild');

let renderer;
function loadRenderer() {
  if (renderer) return renderer;
  // Bundle Angular's browser-oriented ESM imports for a Node test, keeping the
  // real form engine used by Homebridge UI rather than simulating its defaults.
  const filename = path.join(__dirname, 'compiled-settings-renderer.cjs');
  const code = buildSync({
    stdin: {
      contents: "import '@angular/compiler'; export { Injector, runInInjectionContext, NgZone } from '@angular/core'; export { JsonSchemaFormService, WidgetLibraryService } from '@ng-formworks/core';",
      resolveDir: path.dirname(__dirname), sourcefile: 'settings-renderer.mjs',
    },
    bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
  }).outputFiles[0].text;
  const loader = new Module(filename, module);
  loader.filename = filename;
  loader.paths = module.paths;
  loader._compile(code, filename);
  renderer = loader.exports;
  return renderer;
}

function generateConfig(initial, schema = require('../config.schema.json')) {
  const { Injector, runInInjectionContext, NgZone, JsonSchemaFormService, WidgetLibraryService } = loadRenderer();
  const injector = Injector.create({ providers: [{ provide: NgZone, useValue: {
    run: (operation) => operation(), runOutsideAngular: (operation) => operation(),
  } }] });
  const jsf = runInInjectionContext(injector, () => new JsonSchemaFormService());
  try {
    jsf.resetAllValues();
    jsf.setOptions({ addSubmit: false, returnEmptyFields: false, setSchemaDefaults: true });
    jsf.schema = structuredClone(schema.schema);
    jsf.layout = structuredClone(schema.layout);
    jsf.formValues = structuredClone(initial);
    jsf.buildLayout(new WidgetLibraryService());
    jsf.buildFormGroupTemplate(jsf.formValues);
    jsf.buildFormGroup();
    return { data: structuredClone(jsf.data), devices: structuredClone(jsf.formGroup.get('devices').value) };
  } finally {
    jsf.ngOnDestroy();
    injector.destroy();
  }
}

test('the real settings renderer reproduces the old blank row and generates no row with the fixed schema', () => {
  const initial = { username: 'test@example.invalid', password: 'fixture-password' };
  const legacy = structuredClone(require('../config.schema.json'));
  delete legacy.schema.properties.devices['x-schema-form'];
  legacy.layout.find((section) => section.title === 'Appliances').items = ['exposeExtraControls', 'devices'];
  assert.deepEqual(generateConfig(initial, legacy).data.devices, [
    { exclude: false, minTemperature: 16, maxTemperature: 30 },
  ]);
  const fixed = generateConfig(initial);
  assert.deepEqual(fixed.devices, []);
  assert.deepEqual(fixed.data.devices ?? [], []);
});

test('reopening settings with an empty device list does not reinsert a default row', () => {
  const generated = generateConfig({ ...require('../config.example.json'), devices: [] });
  assert.deepEqual(generated.devices, []);
  assert.deepEqual(generated.data.devices ?? [], []);
});

test('an explicitly added device row keeps its SAID, name, and configured limits', () => {
  const generated = generateConfig({ ...require('../config.example.json'), devices: [
    { said: 'TEST-SAID', name: 'Bedroom AC', minTemperature: 17, maxTemperature: 28 },
  ] });
  assert.equal(generated.data.devices.length, 1);
  assert.deepEqual(generated.data.devices[0], {
    said: 'TEST-SAID', name: 'Bedroom AC', exclude: false, minTemperature: 17, maxTemperature: 28,
  });
});
