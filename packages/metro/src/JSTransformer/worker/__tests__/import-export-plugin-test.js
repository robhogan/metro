/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+js_foundation
 * @format
 */
'use strict';

const importExportPlugin = require('../import-export-plugin');

const {compare} = require('../test-helpers');

const opts = {
  importAll: '_$$_IMPORT_ALL',
  importDefault: '_$$_IMPORT_DEFAULT',
};

it('correctly transforms and extracts "import" statements', () => {
  const code = `
    import v from 'foo';
    import * as w from 'bar';
    import {x} from 'baz';
    import {y as z} from 'qux';
    import 'side-effect';
  `;

  const expected = `
    require('side-effect');
    var z = require('qux').y;
    var x = require('baz').x;
    var w = _$$_IMPORT_ALL('bar');
    var v = _$$_IMPORT_DEFAULT('foo');
  `;

  compare([importExportPlugin], code, expected, opts);
});

it('correctly transforms complex patterns', () => {
  const code = `
    import a, * as b from 'foo';
    import c, {d as e, f} from 'bar';
  `;

  const expected = `
    var c = _$$_IMPORT_DEFAULT('bar');
    var e = require('bar').d;
    var f = require('bar').f;
    var a = _$$_IMPORT_DEFAULT('foo');
    var b = _$$_IMPORT_ALL('foo');
  `;

  compare([importExportPlugin], code, expected, opts);
});

it('hoists declarations to the top', () => {
  const code = `
    foo();
    import {foo} from 'bar';
  `;

  const expected = `
    var foo = require('bar').foo;
    foo();
  `;

  compare([importExportPlugin], code, expected, opts);
});

it('enables module exporting when something is exported', () => {
  const code = `
    foo();
    import {foo} from 'bar';
    export default foo;
  `;

  const expected = `
    exports.__esModule = true;

    var foo = require('bar').foo;
    foo();

    var _default = foo;
    exports.default = _default;
  `;

  compare([importExportPlugin], code, expected, opts);
});
