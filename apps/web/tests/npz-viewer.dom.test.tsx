import { describe, it, expect } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { NpzArrayView } from "@/components/file-viewer/NpzArrayView";
import { parseNpzArrays, dtypeLabel, shapeLabel } from "@/lib/file-viewer/npz";

// A real .npz (numpy savez_compressed) with two arrays:
//   embeddings: float32, shape (150, 768)
//   ids:        int64,   shape (3,)
// Base64-embedded so the test parses genuine ZIP + .npy header bytes (no numpy,
// no array-data load) end-to-end through the same code path the UI uses.
const NPZ_B64 = "UEsDBC0AAAAIAAAAIQApKrKf//////////8OABQAZW1iZWRkaW5ncy5ucHkBABAAgAgHAAAAAAAkAgAAAAAAAO3IvQ7BUACA0Vo9xd0uSQcSfxGzjVgMJmm0jUFUbsUinsILq81sPmf7vvd2v9kdetkje8ayak8pLkNc1ZOYh1g36Z6K67FJZfX96+LSVt1vz8Wt6nowno7yMJ8thnl4hb/0MwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+PEBUEsDBC0AAAAIAAAAIQD3QBLq//////////8HABQAaWRzLm5weQEAEACYAAAAAAAAAEwAAAAAAAAAm+wX6hsQychQxlCtnpJanFykbqWgbpNpoa6joJ6WX1RSlJgXn1+UkgoSd0vMKU4FihdnJBakAvkaxjqaOgq1ChQALgYoYITSTFAaAFBLAQItAy0AAAAIAAAAIQApKrKfJAIAAIAIBwAOAAAAAAAAAAAAAACAAQAAAABlbWJlZGRpbmdzLm5weVBLAQItAy0AAAAIAAAAIQD3QBLqTAAAAJgAAAAHAAAAAAAAAAAAAACAAWQCAABpZHMubnB5UEsFBgAAAAACAAIAcQAAAOkCAAAAAA==";

function npzBuffer(): ArrayBuffer {
  const bin = atob(NPZ_B64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

describe("npz parser + NpzArrayView", () => {
  it("parses .npy headers from a real .npz (shape + dtype, no data load)", async () => {
    const arrays = await parseNpzArrays(npzBuffer());
    expect(arrays.map((a) => a.name)).toEqual(["embeddings", "ids"]);
    const emb = arrays.find((a) => a.name === "embeddings")!;
    expect(emb.shape).toEqual([150, 768]);
    expect(emb.dtype).toBe("<f4");
    expect(dtypeLabel(emb.dtype)).toBe("float32");
    expect(shapeLabel(emb.shape)).toBe("150 × 768");
    const ids = arrays.find((a) => a.name === "ids")!;
    expect(ids.shape).toEqual([3]);
    expect(dtypeLabel(ids.dtype)).toBe("int64");
  });

  it("renders a flat array table (name, shape, dtype)", async () => {
    render(<NpzArrayView load={async () => npzBuffer()} />);
    expect(await screen.findByText("embeddings")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("150 × 768")).toBeInTheDocument());
    expect(screen.getByText("float32")).toBeInTheDocument();
    expect(screen.getByText("ids")).toBeInTheDocument();
    expect(screen.getByText("int64")).toBeInTheDocument();
    expect(screen.getByText("array")).toBeInTheDocument(); // header
  });
});
