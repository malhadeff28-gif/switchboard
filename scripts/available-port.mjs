import {createServer} from 'node:net';

// Let the OS avoid reserved ranges, including Hyper-V exclusions on Windows.
export async function availablePort() {
  const probe=createServer();
  await new Promise((resolve,reject)=>{
    probe.once('error',reject);
    probe.listen(0,'127.0.0.1',resolve);
  });
  const port=probe.address().port;
  await new Promise((resolve,reject)=>probe.close(error=>error?reject(error):resolve()));
  return port;
}
