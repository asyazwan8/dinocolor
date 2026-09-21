import { BackSide, MeshBasicMaterial, type Texture } from "three";

/**
 * The look: flat paper, not a lit 3D toy.
 *
 * Unlit, so the child's crayon is the only thing that decides a colour - the same
 * promise the 2D screen made. The form is carried entirely by the silhouette and by the
 * outline, which is how the printed drawing carried it too.
 */
export function paperMaterial(map: Texture): MeshBasicMaterial {
  const material = new MeshBasicMaterial({ map, transparent: true, alphaTest: 0.5 });
  map.flipY = false;
  return material;
}

/**
 * The outline, as an inverted hull: the same mesh again, backfaces only, pushed out
 * along its normals in near-black. What survives is a band around the true silhouette.
 *
 * This is the part that makes the whole direction worth it. On the page an outline is
 * ink somebody drew, so wherever nobody drew one - the top of a leg, under the belly -
 * there is nothing to show, and five revisions of the 2D rig broke on exactly that.
 * Here the outline is computed from the surface every frame. It cannot be missing, it
 * cannot be cut off, and no colour can escape past it.
 *
 * The push happens before skinning, so the hull travels with the pose rather than
 * peeling off it.
 */
/** A material that carries its own width, so it can be rescaled after it is built. */
export type OutlineMaterial = MeshBasicMaterial & { outlineWidth: { value: number } };

/**
 * @param width in the mesh's OWN units. That is canonical pixels for a creature
 *   inflated from the drawing, and something else entirely for a model that arrived at
 *   whatever scale its author chose - a fox about one unit long turns a width of six
 *   into a hull a thousand times its own size. `setOutlineWidth` exists for that.
 */
export function outlineMaterial(width: number): OutlineMaterial {
  const outlineWidth = { value: width };
  const material = new MeshBasicMaterial({
    color: 0x191919,
    side: BackSide,
  }) as OutlineMaterial;
  material.outlineWidth = outlineWidth;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.outlineWidth = outlineWidth;
    shader.vertexShader = shader.vertexShader
      .replace("void main() {", "uniform float outlineWidth;\nvoid main() {")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
\ttransformed += objectNormal * outlineWidth;
\t// And away from the camera, far enough that the hull can never come forward of
\t// the skin. Without this it pokes through wherever the surface creases - at the
\t// top of every leg, which is precisely where it would be noticed. The view is
\t// orthographic, so pushing along the view axis costs the outline nothing on
\t// screen.
\ttransformed.z -= outlineWidth * 40.0;`,
      );
  };
  return material;
}
