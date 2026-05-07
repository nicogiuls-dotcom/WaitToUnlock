/* Static loader for tlock-js. Lives in its own file so that if the
   esm.sh fetch fails, only this dynamic-imported module rejects —
   the main app stays alive and can surface a friendly error. */
import {
  timelockEncrypt,
  timelockDecrypt,
  HttpChainClient,
  HttpCachingChain,
  roundAt,
  Buffer,
} from 'https://esm.sh/tlock-js@0.9.0';

const QUICKNET_CHAIN_INFO = {
  public_key:
    '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  period: 3,
  genesis_time: 1692803367,
  hash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  groupHash: 'f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e',
  schemeID: 'bls-unchained-g1-rfc9380',
  metadata: { beaconID: 'quicknet' },
};
const QUICKNET_URL =
  'https://api.drand.sh/52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971';

const drandChain = new HttpCachingChain(QUICKNET_URL, QUICKNET_CHAIN_INFO);
const drandClient = new HttpChainClient(drandChain);

export async function encryptPin(pin, unlockMs) {
  const round = roundAt(unlockMs, QUICKNET_CHAIN_INFO) + 1;
  const ciphertext = await timelockEncrypt(round, Buffer.from(pin, 'utf-8'), drandClient);
  return { ciphertext, round };
}

export async function decryptPin(ciphertext) {
  const buf = await timelockDecrypt(ciphertext, drandClient);
  return buf.toString('utf-8');
}
