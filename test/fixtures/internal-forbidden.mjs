// Private test service counting any forbidden direct TCP/UDP contact.
import http from 'node:http';
import dgram from 'node:dgram';
import fs from 'node:fs';

let count = 0;
const update = () => fs.writeFileSync('/tmp/forbidden-count', String(++count));
fs.writeFileSync('/tmp/forbidden-count', '0');
http.createServer((_request, response) => { update(); response.writeHead(200); response.end('unexpected'); }).listen(8444, '0.0.0.0');
const udp = dgram.createSocket('udp4');
udp.on('message', update);
udp.bind(8444, '0.0.0.0');
console.log('forbidden mock ready');
