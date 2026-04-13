/// <reference types="vite/client" />

// Allow ?raw imports for markdown and text files
declare module '*?raw' {
  const content: string;
  export default content;
}
