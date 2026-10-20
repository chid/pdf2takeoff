// Vite serves both the landing/demo and the real PDF workspace, including
// the locally bundled PDF worker and same-origin font/decoder resources.
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
const server=await createServer({
  configFile:fileURLToPath(new URL('vite.config.mjs',import.meta.url)),
  server:{host:'127.0.0.1',port:5174,strictPort:true},
});
await server.listen();
console.log('Legend: http://127.0.0.1:5174');
