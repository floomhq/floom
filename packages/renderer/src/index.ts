// @floom/renderer — default + custom renderer library.
//
// Public surface:
//   - RenderProps (contract)
//   - RendererShell + RendererErrorBoundary
//   - defaultOutputs / getDefaultOutput (10 output shapes)
//   - defaultInputs / getDefaultInput (13 input kinds)
//   - pickOutputShape / parseRendererManifest (pure helpers)
//
// Every creator-shipped custom renderer imports ONLY the RenderProps type.
// Host apps import RendererShell + pickOutputShape + everything else.

export * from './contract/index.js';
export * from './outputs/index.js';
export * from './inputs/index.js';
export * from './json/index.js';
export { RendererShell, RendererErrorBoundary, resolveRenderTarget } from './RendererShell.js';
