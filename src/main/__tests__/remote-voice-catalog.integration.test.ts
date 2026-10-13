import { createServer, type Server } from "node:http";
import { afterEach, expect, it } from "vitest";
import {
  listRemoteVoices,
  synthesizeRemoteVoice,
} from "../remote-media-runtime";

let boundary: Server | undefined;
afterEach(async () => {
  if (boundary)
    await new Promise<void>((resolve) => boundary!.close(() => resolve()));
});

it.each(["kokoro-82m-v1.0.onnx", "other-tts"])(
  "reads remote OGAD voices for %s and sends the selected voice",
  async (model) => {
    boundary = createServer(async (req, res) => {
      if (req.headers.authorization !== "Bearer fixture-key") {
        res.writeHead(401);
        res.end();
        return;
      }
      if (req.method === "GET" && req.url === "/v1/audio/voices") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            voices: ["af_heart", "hf_alpha", "ff_siwis", 9, null, ""],
          }),
        );
        return;
      }
      if (req.method === "POST" && req.url === "/v1/audio/speech") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const payload = JSON.parse(body);
        if (
          payload.voice !== "hf_alpha" ||
          payload.model !== model ||
          payload.input !== "नमस्ते"
        ) {
          res.writeHead(400);
          res.end();
          return;
        }
        res.setHeader("content-type", "audio/wav");
        res.end("fixture-audio");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) =>
      boundary!.listen(0, "127.0.0.1", resolve),
    );
    const address = boundary.address();
    if (!address || typeof address === "string")
      throw Error("Missing fixture port");
    const server = {
      id: model,
      name: "Fixture",
      provider: "ogad" as const,
      endpoint: `http://127.0.0.1:${address.port}/v1`,
      selectedModel: model,
      model,
      apiKey: "fixture-key",
      screenFramesAllowed: false,
    };
    const voices = await listRemoteVoices(server);
    expect(voices.map((v) => v.id)).toEqual([
      "af_heart",
      "hf_alpha",
      "ff_siwis",
    ]);
    expect(voices.map((v) => v.language)).toEqual(
      model.startsWith("kokoro")
        ? ["en-US", "hi", "fr"]
        : [undefined, undefined, undefined],
    );
    const audio = await synthesizeRemoteVoice(server, "नमस्ते", voices[1]!.id);
    expect(audio.dataUrl).toBe(
      `data:audio/wav;base64,${Buffer.from("fixture-audio").toString("base64")}`,
    );
  },
);
