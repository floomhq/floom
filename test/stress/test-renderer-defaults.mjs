#!/usr/bin/env node
// Default renderer tests.
//
// Uses react-dom/server.renderToStaticMarkup to server-render each default
// output component and assert the resulting HTML contains the expected
// tags + text. Also exercises the pure helpers (rowsToCsv, coerceImageSrc,
// coercePdfSrc, coerceAudioSrc, eventsToLines, autoPrefixUrl).
//
// We skip MarkdownOutput + CodeOutput runtime-loaded deps (react-markdown,
// shiki) because they pull DOM-heavy machinery; their fallback paths are
// what we assert here. A Phase 3 upgrade can add JSDOM.

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  TextOutput,
  TableOutput,
  ObjectOutput,
  ImageOutput,
  PdfOutput,
  AudioOutput,
  StreamOutput,
  ErrorOutput,
  rowsToCsv,
  coerceImageSrc,
  coercePdfSrc,
  coerceAudioSrc,
  eventsToLines,
  defaultOutputs,
  getDefaultOutput,
} from '../../packages/renderer/src/outputs/index.ts';
import {
  autoPrefixUrl,
  defaultInputs,
  defaultInputKinds,
  getDefaultInput,
} from '../../packages/renderer/src/inputs/index.tsx';

let passed = 0;
let failed = 0;

function log(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`);
  }
}

function render(el) {
  return renderToStaticMarkup(el);
}

console.log('default renderer tests');

// ---- 10 output shapes registered ----
log(
  'defaultOutputs has all 10 shapes',
  Object.keys(defaultOutputs).length === 10 &&
    ['text', 'markdown', 'code', 'table', 'object', 'image', 'pdf', 'audio', 'stream', 'error'].every(
      (k) => typeof defaultOutputs[k] === 'function',
    ),
);
log(
  'getDefaultOutput("table") returns the table component',
  getDefaultOutput('table') === defaultOutputs.table,
);
log(
  'getDefaultOutput unknown → TextOutput',
  getDefaultOutput('xyz') === defaultOutputs.text,
);

// ---- TextOutput ----
const textHtml = render(
  React.createElement(TextOutput, { state: 'output-available', data: 'hello world' }),
);
log('TextOutput: renders string verbatim', textHtml.includes('hello world'));
log('TextOutput: uses <pre> wrapper', textHtml.includes('<pre'));

const textLoadingHtml = render(
  React.createElement(TextOutput, { state: 'input-available', loading: true }),
);
log('TextOutput: loading shows ellipsis', textLoadingHtml.includes('…'));

// ---- TableOutput ----
const tableHtml = render(
  React.createElement(TableOutput, {
    state: 'output-available',
    data: [
      { origin: 'BER', destination: 'LIS', price: 120 },
      { origin: 'BER', destination: 'LIS', price: 150 },
    ],
  }),
);
log('TableOutput: renders table tag', tableHtml.includes('<table'));
log('TableOutput: renders 2 rows label', tableHtml.includes('2 rows'));
log('TableOutput: has Copy JSON button', tableHtml.includes('Copy JSON'));
log('TableOutput: has Download CSV button', tableHtml.includes('Download CSV'));
log('TableOutput: column headers present', tableHtml.includes('origin') && tableHtml.includes('price'));

// ---- rowsToCsv pure helper ----
const csv = rowsToCsv(
  [
    { a: 1, b: 'hello' },
    { a: 2, b: 'he said "hi"' },
  ],
  ['a', 'b'],
);
log('rowsToCsv: header row present', csv.split('\n')[0] === '"a","b"');
log('rowsToCsv: values quoted', csv.split('\n')[1] === '"1","hello"');
log(
  'rowsToCsv: internal quotes doubled',
  csv.split('\n')[2] === '"2","he said ""hi"""',
);

// ---- ObjectOutput ----
const objectHtml = render(
  React.createElement(ObjectOutput, {
    state: 'output-available',
    data: { carrier: 'Lufthansa', price: 120, stops: 0 },
  }),
);
log('ObjectOutput: dl element present', objectHtml.includes('<dl'));
log('ObjectOutput: key name present', objectHtml.includes('carrier'));
log('ObjectOutput: value present', objectHtml.includes('Lufthansa'));

// ---- ImageOutput ----
log(
  'coerceImageSrc: http url → passes through',
  coerceImageSrc('https://example.com/a.png') === 'https://example.com/a.png',
);
log(
  'coerceImageSrc: data url → passes through',
  coerceImageSrc('data:image/png;base64,xxx') === 'data:image/png;base64,xxx',
);
log(
  'coerceImageSrc: object.url → picks url',
  coerceImageSrc({ url: 'https://ex.com/b.jpg' }) === 'https://ex.com/b.jpg',
);
log(
  'coerceImageSrc: object.src → picks src',
  coerceImageSrc({ src: 'https://ex.com/c.jpg' }) === 'https://ex.com/c.jpg',
);
log('coerceImageSrc: null → null', coerceImageSrc(null) === null);

const imgHtml = render(
  React.createElement(ImageOutput, {
    state: 'output-available',
    data: 'https://example.com/a.png',
  }),
);
log('ImageOutput: renders img tag', imgHtml.includes('<img'));
log('ImageOutput: src attribute set', imgHtml.includes('https://example.com/a.png'));

// ---- PdfOutput ----
log(
  'coercePdfSrc: data url → passes through',
  coercePdfSrc('data:application/pdf;base64,xxx').startsWith('data:application/pdf'),
);
const pdfHtml = render(
  React.createElement(PdfOutput, {
    state: 'output-available',
    data: 'https://example.com/a.pdf',
  }),
);
log('PdfOutput: renders iframe', pdfHtml.includes('<iframe'));
log('PdfOutput: has open-in-new-tab link', pdfHtml.includes('Open PDF'));

// ---- AudioOutput ----
log(
  'coerceAudioSrc: object.url → picks url',
  coerceAudioSrc({ url: 'https://ex.com/s.mp3' }) === 'https://ex.com/s.mp3',
);
const audioHtml = render(
  React.createElement(AudioOutput, {
    state: 'output-available',
    data: { url: 'https://example.com/a.mp3' },
  }),
);
log('AudioOutput: renders audio tag', audioHtml.includes('<audio'));
log('AudioOutput: controls attr', audioHtml.includes('controls'));

// ---- StreamOutput ----
log(
  'eventsToLines: string → split on newline',
  JSON.stringify(eventsToLines('a\nb\nc')) === JSON.stringify(['a', 'b', 'c']),
);
log(
  'eventsToLines: array of strings → passthrough',
  JSON.stringify(eventsToLines(['x', 'y'])) === JSON.stringify(['x', 'y']),
);
log(
  'eventsToLines: array of objects → stringified',
  JSON.stringify(eventsToLines([{ a: 1 }])) === JSON.stringify(['{"a":1}']),
);
const streamHtml = render(
  React.createElement(StreamOutput, {
    state: 'output-available',
    data: ['line1', 'line2'],
  }),
);
log('StreamOutput: renders lines', streamHtml.includes('line1') && streamHtml.includes('line2'));

// ---- ErrorOutput ----
const errHtml = render(
  React.createElement(ErrorOutput, {
    state: 'output-error',
    error: { message: 'boom', code: 'oops' },
  }),
);
log('ErrorOutput: renders message', errHtml.includes('boom'));
log('ErrorOutput: renders code', errHtml.includes('oops'));
log('ErrorOutput: role=alert', errHtml.includes('role="alert"'));

// ---- 13 input shapes registered ----
log(
  'defaultInputs has all 13 kinds',
  defaultInputKinds.length === 13 &&
    ['text', 'textarea', 'date', 'url', 'enum', 'number', 'boolean', 'array', 'file/csv', 'file/image', 'file/pdf', 'file/audio', 'object'].every(
      (k) => typeof defaultInputs[k] === 'function',
    ),
);
log(
  'getDefaultInput("enum") returns the enum component',
  getDefaultInput('enum') === defaultInputs['enum'],
);
log(
  'getDefaultInput("xyz") → text fallback',
  getDefaultInput('xyz') === defaultInputs.text,
);

// ---- autoPrefixUrl pure helper ----
log(
  'autoPrefixUrl: bare → https://',
  autoPrefixUrl('example.com') === 'https://example.com',
);
log(
  'autoPrefixUrl: https:// passthrough',
  autoPrefixUrl('https://example.com') === 'https://example.com',
);
log(
  'autoPrefixUrl: http:// passthrough',
  autoPrefixUrl('http://example.com') === 'http://example.com',
);
log('autoPrefixUrl: empty → empty', autoPrefixUrl('') === '');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
