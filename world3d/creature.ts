import {
  BufferAttribute,
  BufferGeometry,
  Bone,
  Group,
  Skeleton,
  SkinnedMesh,
  Uint16BufferAttribute,
  type Material,
} from "three";

/**
 * Load the inflated drawing: one continuous skinned mesh, built offline by
 * `scripts/buildCreature.mjs` from the same part masks the 2D rig uses.
 *
 * Continuous is the whole point. The 2D rig had to cut the drawing into pieces and hide
 * the cuts, because a flat drawing has no outline where a limb enters the body - nobody
 * drew one. Here the surface never stops, so there is no cut to hide, and the outline is
 * generated from the real silhouette instead of being read off the page.
 */

export interface CreatureData {
  slug: string;
  mesh: string;
  vertices: number;
  triangles: number;
  layout: Record<string, { offset: number; length: number }>;
  bones: { id: string; parent: string | null; head: { x: number; y: number; z: number } }[];
  footDrop: number;
  extent: { left: number; right: number };
  artwork: { src: string; w: number; h: number; x: number; y: number };
  texture: { w: number; h: number };
}

export interface Creature {
  /** Everything for one dinosaur: the outline hull, the skin, and the skeleton. */
  group: Group;
  mesh: SkinnedMesh;
  skeleton: Skeleton;
  /** Bone id -> bone, so the gait can pose by name. */
  bones: Map<string, Bone>;
  root: Bone;
}

/** Shared per species: the geometry and the skeleton never depend on the colouring. */
const geometryCache = new Map<string, Promise<BufferGeometry>>();

async function loadGeometry(data: CreatureData): Promise<BufferGeometry> {
  const response = await fetch(data.mesh);
  if (!response.ok) throw new Error(`creature mesh ${data.mesh}: ${response.status}`);
  const buffer = await response.arrayBuffer();

  const slice = (name: string, stride: number) => {
    const { offset, length } = data.layout[name];
    return { offset, length, stride };
  };

  const geometry = new BufferGeometry();
  const f32 = (name: string, stride: number) => {
    const { offset, length } = slice(name, stride);
    return new BufferAttribute(new Float32Array(buffer, offset, length), stride);
  };

  geometry.setAttribute("position", f32("position", 3));
  geometry.setAttribute("normal", f32("normal", 3));
  geometry.setAttribute("uv", f32("uv", 2));
  geometry.setAttribute(
    "skinIndex",
    new Uint16BufferAttribute(
      new Uint16Array(buffer, data.layout.skinIndex.offset, data.layout.skinIndex.length),
      4,
    ),
  );
  geometry.setAttribute("skinWeight", f32("skinWeight", 4));
  geometry.setIndex(
    new BufferAttribute(
      new Uint32Array(buffer, data.layout.index.offset, data.layout.index.length),
      1,
    ),
  );
  return geometry;
}

function cachedGeometry(data: CreatureData): Promise<BufferGeometry> {
  let pending = geometryCache.get(data.slug);
  if (!pending) {
    pending = loadGeometry(data);
    geometryCache.set(data.slug, pending);
  }
  return pending;
}

/**
 * Build one creature. The geometry is shared; the skeleton is not, because every
 * dinosaur on the screen is mid-stride at a different moment.
 */
export async function makeCreature(
  data: CreatureData,
  material: Material,
  outlineMaterial: Material,
): Promise<Creature> {
  const geometry = await cachedGeometry(data);

  const bones = new Map<string, Bone>();
  const order: Bone[] = [];
  for (const spec of data.bones) {
    const bone = new Bone();
    bone.name = spec.id;
    bones.set(spec.id, bone);
    order.push(bone);
  }

  let root: Bone | null = null;
  data.bones.forEach((spec, i) => {
    const bone = order[i];
    const parent = spec.parent ? bones.get(spec.parent) : null;
    if (parent) {
      const head = data.bones.find((b) => b.id === spec.parent)!.head;
      bone.position.set(spec.head.x - head.x, spec.head.y - head.y, spec.head.z - head.z);
      parent.add(bone);
    } else {
      bone.position.set(spec.head.x, spec.head.y, spec.head.z);
      root = bone;
    }
  });
  if (!root) throw new Error(`${data.slug} has no root bone`);

  const mesh = new SkinnedMesh(geometry, material);
  // The skin's indices are in the same order as `data.bones`, which is rig order.
  mesh.add(root);
  mesh.updateMatrixWorld(true);
  const skeleton = new Skeleton(order);
  mesh.bind(skeleton);
  mesh.frustumCulled = false;

  // The outline is the same surface again, one pose behind nothing: it shares the
  // geometry and the skeleton, so it can never drift out of step with the skin.
  const outline = new SkinnedMesh(geometry, outlineMaterial);
  outline.bind(skeleton, mesh.bindMatrix);
  outline.frustumCulled = false;
  outline.renderOrder = -1;

  const group = new Group();
  group.add(outline);
  group.add(mesh);

  return { group, mesh, skeleton, bones, root };
}
