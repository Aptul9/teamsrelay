import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import net from "node:net";
import webpush from "web-push";

// A push service on 127.0.0.1 standing in for Google's, Apple's or Mozilla's: it decrypts what it receives with the
// keys of the device it made up (RFC 8291, aes128gcm) and checks the VAPID signature (RFC 8292). The agent's own
// web-push call runs unchanged, only its connection is plain TCP to this service instead of TLS to the real one.

export type Received = {
  payload: unknown;
  ttl: string | undefined;
  urgency: string | undefined;
  topic: string | undefined;
  vapid: { aud: string; sub: string; exp: number; k: string } | null;
};

type Answer = { status: number; headers?: Record<string, string> };

const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();

export async function fakePushService() {
  const device = createECDH("prime256v1");
  device.generateKeys();
  const auth = randomBytes(16);
  const received: Received[] = [];
  // answers for the next requests, in order; then 201
  const answers: Answer[] = [];

  function decrypt(body: Buffer): unknown {
    const salt = body.subarray(0, 16);
    const idlen = body[20];
    const serverKey = body.subarray(21, 21 + idlen);
    const data = body.subarray(21 + idlen);
    const prkKey = hmac(auth, device.computeSecret(serverKey));
    const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), device.getPublicKey(), serverKey, Buffer.from([1])]));
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
    const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
    const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
    decipher.setAuthTag(data.subarray(-16));
    const plain = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
    // the record: the payload, 0x02 (last record), zero padding
    let end = plain.length - 1;
    while (end >= 0 && plain[end] === 0) end--;
    if (plain[end] !== 2) throw new Error("padding delimiter missing");
    return JSON.parse(plain.subarray(0, end).toString("utf8"));
  }

  function vapid(header: string | undefined): Received["vapid"] {
    const m = /^vapid t=([^,\s]+),\s*k=(\S+)$/.exec(header ?? "");
    if (!m) return null;
    const [h, p, s] = m[1].split(".");
    const point = Buffer.from(m[2], "base64url");
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") }, format: "jwk" });
    if (!verify("sha256", Buffer.from(`${h}.${p}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"))) return null;
    return { ...JSON.parse(Buffer.from(p, "base64url").toString("utf8")), k: m[2] };
  }

  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let payload: unknown;
    try {
      payload = decrypt(Buffer.concat(chunks));
    } catch (e) {
      payload = { error: String(e) };
    }
    const h = (name: string) => req.headers[name] as string | undefined;
    received.push({ payload, ttl: h("ttl"), urgency: h("urgency"), topic: h("topic"), vapid: vapid(h("authorization")) });
    const answer = answers.shift() ?? { status: 201 };
    res.writeHead(answer.status, answer.headers).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  // web-push always speaks HTTPS: this agent gives it a plain connection to the service above
  const agent = new https.Agent();
  (agent as unknown as { createConnection: () => net.Socket }).createConnection = () => net.connect(port, "127.0.0.1");

  return {
    received,
    // what a browser gets from pushManager.subscribe() on this device
    subscription: (name = "device") => ({ endpoint: `https://push.test/${name}`, keys: { p256dh: device.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } }),
    // the send function of the Notifier: the real web-push call, through the agent above
    send: (s: webpush.PushSubscription, payload: string, options: webpush.RequestOptions) => webpush.sendNotification(s, payload, { ...options, agent }),
    answer: (status: number, headers?: Record<string, string>) => answers.push({ status, headers }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
