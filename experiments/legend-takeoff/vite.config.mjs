import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { cpSync, mkdirSync } from 'node:fs';
const resources=fileURLToPath(new URL('.resources/pdf-resources/',import.meta.url));
mkdirSync(resources,{recursive:true});
for(const name of ['cmaps','standard_fonts','wasm'])cpSync(fileURLToPath(new URL('../../node_modules/pdfjs-dist/'+name,import.meta.url)),resources+'/'+name,{recursive:true});
cpSync(fileURLToPath(new URL('../../node_modules/pdfjs-dist/LICENSE',import.meta.url)),resources+'/LICENSE');
export default defineConfig({
  root:fileURLToPath(new URL('.',import.meta.url)),
  base:'/',
  publicDir:'.resources',
  build:{outDir:'.build',emptyOutDir:true,target:'es2022',rollupOptions:{input:fileURLToPath(new URL('workspace.html',import.meta.url))}},
  server:{host:'127.0.0.1',port:5175,fs:{allow:[fileURLToPath(new URL('../..',import.meta.url))]}}
});
