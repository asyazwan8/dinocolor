import {
  AnimationMixer,
  Box3,
  Group,
  Object3D,
  SkinnedMesh,
  Vector3,
  type AnimationClip,
  type Material,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { OutlineMaterial } from "./toon";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";

/**
 * A modelled, rigged, hand-animated creature, wearing a child's drawing.
 *
 * This is the other half of the argument. `creature.ts` inflates the drawing itself,
 * which costs no art per species and gives legs that are one bone on a hinge - a
 * pendulum, with a foot that slides through the ground. Here the motion is authored by
 * an animator and the drawing is only paint, which is how teamLab's sketch animals work
 * and why their legs read as legs.
 *
 * Nothing about the model is derived from what the child drew, and nothing about the
 * drawing survives into the motion. That separation is the point.
 */

/** Where the model should end up, in canonical texture pixels. */
export interface Placement {
  /** Nose to tail, matched to the drawing's width. */
  length: number;
  /** Ground level - where the feet go. */
  feetY: number;
  centreX: number;
}

export interface Rigged {
  group: Group;
  mesh: SkinnedMesh;
  mixer: AnimationMixer;
  clipNames: string[];
  play(name: string, timeScale?: number): void;
}

/** Shared per species: the geometry and the clips never depend on the colouring. */
const cache = new Map<string, Promise<{ scene: Group; clips: AnimationClip[] }>>();

function cached(url: string) {
  let pending = cache.get(url);
  if (!pending) {
    pending = new GLTFLoader()
      .loadAsync(url)
      .then((gltf) => ({ scene: gltf.scene as Group, clips: gltf.animations }));
    cache.set(url, pending);
  }
  return pending;
}

function findSkinnedMesh(root: Object3D): SkinnedMesh {
  let found: SkinnedMesh | null = null;
  root.traverse((child) => {
    if (!found && (child as SkinnedMesh).isSkinnedMesh) found = child as SkinnedMesh;
  });
  if (!found) throw new Error("no skinned mesh in that model");
  return found;
}

/**
 * Put an arbitrary model into the page's own coordinates.
 *
 * Models arrive at whatever scale, facing and origin their author chose, and this one
 * has to stand in the same valley as a creature measured in canonical texture pixels -
 * a thousand-odd units wide, with its feet some hundreds of units below the origin. A
 * model left at its own scale and origin is a speck in the corner, which is exactly
 * what happened the first time this ran.
 *
 * So: turn it side on if it was built facing the camera, scale it to the drawing's
 * width, and stand it where the inflated creature stands.
 */
function normalise(group: Group, place: Placement): number {
  group.updateMatrixWorld(true);
  const box = new Box3().setFromObject(group);
  const size = box.getSize(new Vector3());

  // Longest horizontal axis runs along x, because the valley is seen from the side.
  if (size.z > size.x) {
    group.rotation.y = Math.PI / 2;
    group.updateMatrixWorld(true);
    box.setFromObject(group);
    box.getSize(size);
  }

  const scale = place.length / size.x;
  group.scale.multiplyScalar(scale);
  group.updateMatrixWorld(true);

  box.setFromObject(group);
  const centre = box.getCenter(new Vector3());
  group.position.x += place.centreX - centre.x;
  group.position.y += place.feetY - box.min.y;
  return scale;
}

export async function makeRigged(
  url: string,
  material: Material,
  outline: OutlineMaterial,
  place: Placement,
): Promise<Rigged> {
  const source = await cached(url);

  // SkeletonUtils, not Object3D.clone: a plain clone of a skinned mesh keeps pointing at
  // the ORIGINAL skeleton's bones, so every dinosaur on the screen would share one pose.
  const group = cloneSkinned(source.scene) as Group;

  const mesh = findSkinnedMesh(group);
  mesh.material = material;
  mesh.frustumCulled = false;

  // NO OUTLINE HULL HERE YET, deliberately.
  //
  // A second SkinnedMesh sharing this one's skeleton renders in the bind pose while the
  // skin walks away from it - a whole second creature in black. Binding by hand and
  // `SkinnedMesh.copy` both do it, so the cause is something else and I have not found
  // it. The outline is a technique already proven on the inflated creature and is not
  // what this spike is asking about, so it waits rather than eating the question.
  void outline;

  const scale = normalise(group, place);
  // The hull pushes vertices along their normals in the mesh's OWN units, and this
  // model's units are not the page's. Divide the width back through the scale that was
  // just applied, or the outline comes out a thousand times too thick.
  outline.outlineWidth.value /= scale;

  const mixer = new AnimationMixer(group);
  const play = (name: string, timeScale = 1) => {
    const clip = source.clips.find((c) => c.name === name);
    if (!clip) {
      throw new Error(
        `no clip "${name}" - have ${source.clips.map((c) => c.name).join(", ")}`,
      );
    }
    mixer.stopAllAction();
    const action = mixer.clipAction(clip);
    action.timeScale = timeScale;
    action.play();
  };

  return {
    group,
    mesh,
    mixer,
    clipNames: source.clips.map((c) => c.name),
    play,
  };
}
