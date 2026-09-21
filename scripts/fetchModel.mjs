/**
 * Vendor a rigged, hand-animated model into the repo.
 *
 *   node scripts/fetchModel.mjs
 *     -> public/assets/models/fox.glb
 *     -> public/assets/models/ATTRIBUTION.md
 *
 * Why a fetched model at all: nine revisions went into deriving motion from the child's
 * drawing, and a leg derived that way is one bone on a hinge - a pendulum with a sliding
 * foot. teamLab's sketch animals do the opposite. Their own description of the mechanism
 * is that a drawing's corners identify its type and the scan is applied as a texture to
 * a CORRESPONDING 3D MODEL: the reindeer walks well because a modeller built it and an
 * animator keyed the walk, and the drawing is only paint.
 *
 * This proves that chain end to end with the one rigged quadruped this environment can
 * actually reach. It is a fox, not a dinosaur; it is here for how it MOVES.
 *
 * Vendored rather than fetched at runtime so the installation never depends on a network
 * it will not have in a venue.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const BASE =
  "https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models/Fox";

/**
 * The rigging and animation - the whole reason this file is here - are CC-BY-4.0, so
 * attribution is a condition of use and ships beside the binary rather than living in a
 * commit message nobody reads.
 */
const ATTRIBUTION = `# Third-party models

## fox.glb

From the Khronos glTF-Sample-Assets repository, \`Models/Fox\`.
Skinned quadruped, 24 joints, with the animation clips Survey, Walk and Run.

Present for its hand-authored walk cycle, which is the thing this project cannot
generate: it is the reference for how a leg should move.

- Model: (c) 2014 PixelMannen - CC0 1.0 Universal
- **Rigging & animation: (c) 2014 tomkranis - CC BY 4.0**
- glTF conversion: (c) 2017 @AsoboStudio and @scurest - CC BY 4.0

CC BY 4.0 requires attribution. If this model ever appears in something shown publicly,
these credits go with it.

https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/Fox
`;

const out = resolve("public/assets/models");
mkdirSync(out, { recursive: true });

const response = await fetch(`${BASE}/glTF-Binary/Fox.glb`);
if (!response.ok) throw new Error(`Fox.glb: ${response.status} ${response.statusText}`);
const glb = Buffer.from(await response.arrayBuffer());

// A glTF binary starts with the magic "glTF"; anything else means a proxy handed back
// an error page with a 200 on it.
if (glb.subarray(0, 4).toString() !== "glTF") {
  throw new Error("that is not a glb - check what the proxy returned");
}

writeFileSync(`${out}/fox.glb`, glb);
writeFileSync(`${out}/ATTRIBUTION.md`, ATTRIBUTION);

const jsonLength = glb.readUInt32LE(12);
const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString("utf8"));
console.log(`fox.glb  ${Math.round(glb.length / 1024)}KB`);
console.log(`  ${gltf.skins?.[0]?.joints?.length ?? 0} joints`);
console.log(`  clips: ${(gltf.animations ?? []).map((a) => a.name).join(", ")}`);
