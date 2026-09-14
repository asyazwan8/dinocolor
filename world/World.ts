import {
  Application,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Texture,
  type Ticker,
} from "pixi.js";
import { dinoScale, type DinoType } from "@/lib/sheet/types";
import { compositeRig } from "./composite";
import { DinoRig } from "./DinoRig";
import { FOREGROUND_STRIP, HORIZON_Y, LANES, REFERENCE_TREE_LANE, STAGE } from "./palette";
import {
  makeClouds,
  makeForeground,
  makeGround,
  makeHills,
  makeMountains,
  makeSky,
  makeTreeline,
} from "./procedural";
import type { Rig } from "./types";

/** The brief: at most ten on screen at once. */
export const MAX_DINOS = 10;

/** Stage pixels per second at a normal walking pace, before lane scaling. */
const WALK_SPEED = 58;

/**
 * Arrivals stride in rather than amble.
 *
 * A child scans their sheet and looks straight up at the screen, so the gap between
 * scanning and seeing their own dinosaur is the moment the whole installation is
 * judged on. At an ambling pace a big rig is barely a nose at the edge after four
 * seconds. It enters at a trot and settles once it is properly in view.
 *
 * The pace is tied to how wide the art is: a rig spawns just off screen, so a wider
 * dinosaur starts further out and takes longer to arrive. Redrawing the art wider is
 * enough to make arrivals feel slow again.
 */
const ENTRY_SPEED = 3.4;

/** Fallback in seconds, so a slow lane cannot leave a dinosaur entering forever. */
const ENTRY_TIMEOUT = 7;

type Behaviour = "enter" | "wander" | "browse" | "exit";

interface LiveDino {
  id: string;
  rig: DinoRig;
  holder: Container;
  shadow: Graphics;
  lane: number;
  x: number;
  facing: 1 | -1;
  speed: number;
  targetSpeed: number;
  behaviour: Behaviour;
  untilChange: number;
  bornAt: number;
  scale: number;
  /** Stage pixels from the dinosaur's position to each edge of its artwork. */
  reachLeft: number;
  reachRight: number;
}

export interface WorldOptions {
  rig: Rig;
  /** The painted valley. Absent falls back to the procedural layers. */
  backdrop?: HTMLImageElement | null;
  /** Reduced motion, for a venue that needs the screen calmer. */
  calm?: boolean;
}

export class World {
  private readonly dinos: LiveDino[] = [];
  private readonly dinoLayer = new Container();
  private clouds!: Sprite;
  private readonly rig: Rig;

  constructor(
    private readonly app: Application,
    options: WorldOptions,
  ) {
    this.rig = options.rig;
    this.buildScenery(options.backdrop ?? null);
    this.app.ticker.add(this.tick);
  }

  private buildScenery(backdrop: HTMLImageElement | null): void {
    const stage = this.app.stage;
    const sprite = (source: HTMLCanvasElement) => new Sprite(Texture.from(source));

    this.dinoLayer.sortableChildren = true;

    if (backdrop) {
      const painted = new Sprite(Texture.from(backdrop));
      painted.width = STAGE.w;
      painted.height = STAGE.h;
      stage.addChild(painted);

      // Clouds still drift, because a completely still sky reads as a photograph
      // rather than a place. Kept faint so it does not fight the painting.
      this.clouds = sprite(makeClouds());
      this.clouds.y = 20;
      this.clouds.alpha = 0.35;
      stage.addChild(this.clouds);

      stage.addChild(this.dinoLayer);

      // The bottom of the painting, drawn again in front of the dinosaurs, so the
      // nearest ones stand IN the meadow rather than on top of it. Same pixels as
      // the backdrop behind, so it costs no extra art and cannot mismatch.
      const grass = new Sprite(
        new Texture({
          source: Texture.from(backdrop).source,
          frame: new Rectangle(
            0,
            backdrop.naturalHeight * (1 - FOREGROUND_STRIP / STAGE.h),
            backdrop.naturalWidth,
            backdrop.naturalHeight * (FOREGROUND_STRIP / STAGE.h),
          ),
        }),
      );
      grass.width = STAGE.w;
      grass.height = FOREGROUND_STRIP;
      grass.y = STAGE.h - FOREGROUND_STRIP;
      stage.addChild(grass);
      return;
    }

    stage.addChild(sprite(makeSky()));

    this.clouds = sprite(makeClouds());
    this.clouds.y = 30;
    stage.addChild(this.clouds);

    stage.addChild(sprite(makeMountains()));
    stage.addChild(sprite(makeHills()));
    stage.addChild(sprite(makeGround()));

    // Dinosaurs and the reference trees share one sorted layer so a near dinosaur
    // passes in front of a tree and a far one behind it. Baking the trees into a
    // flat layer would force every dinosaur to one side of them.
    stage.addChild(this.dinoLayer);

    const trees = sprite(makeTreeline());
    trees.zIndex = LANES[REFERENCE_TREE_LANE].baseline - 1;
    this.dinoLayer.addChild(trees);

    stage.addChild(sprite(makeForeground()));
  }

  get count(): number {
    return this.dinos.filter((d) => d.behaviour !== "exit").length;
  }

  async addDino(
    id: string,
    dino: DinoType,
    colouring: CanvasImageSource,
    /** Fraction across the stage to start at. Omit to walk in from the edge. */
    startAt?: number,
  ): Promise<void> {
    const parts = await compositeRig(this.rig, colouring);
    const rig = new DinoRig(this.rig, parts);

    // Spread arrivals across lanes so the screen fills in depth, not in a row.
    const lane = this.pickLane();
    const laneSpec = LANES[lane];
    const scale = dinoScale(dino) * laneSpec.scale;

    const holder = new Container();
    holder.scale.set(scale);

    const shadow = new Graphics();
    const span = rig.extent.right - rig.extent.left;
    shadow
      .ellipse(
        (rig.extent.left + rig.extent.right) / 2,
        rig.footDrop - 6,
        span * 0.3,
        span * 0.062,
      )
      .fill({ color: 0x24361f, alpha: 0.26 });

    holder.addChild(shadow);
    holder.addChild(rig.container);

    // Haze: fade and cool distant dinosaurs so depth is legible in the air as well
    // as in the scale. Without it a far Brachiosaurus reads as a near Triceratops.
    const haze = laneSpec.haze;
    holder.alpha = 1 - haze * 0.5;
    holder.tint = lerpColour(0xffffff, 0x9dc0dc, haze);
    holder.zIndex = laneSpec.baseline;

    const facing: 1 | -1 = Math.random() < 0.5 ? 1 : -1;

    // Facing flips the artwork, so which way the rig reaches flips with it.
    const reachLeft = Math.abs(facing === 1 ? rig.extent.left : rig.extent.right) * scale;
    const reachRight = Math.abs(facing === 1 ? rig.extent.right : rig.extent.left) * scale;

    // Spawn with the leading edge just past the frame, so the dinosaur is visible
    // almost immediately rather than after walking its own length first.
    const x =
      startAt === undefined
        ? facing === 1
          ? -reachRight
          : STAGE.w + reachLeft
        : startAt * STAGE.w;

    const live: LiveDino = {
      id,
      rig,
      holder,
      shadow,
      lane,
      x,
      facing,
      speed: startAt === undefined ? ENTRY_SPEED : 1,
      targetSpeed: startAt === undefined ? ENTRY_SPEED : 1,
      behaviour: startAt === undefined ? "enter" : "wander",
      untilChange: ENTRY_TIMEOUT,
      bornAt: performance.now(),
      scale,
      reachLeft,
      reachRight,
    };

    this.dinoLayer.addChild(holder);
    this.dinos.push(live);
    this.place(live);

    this.enforceCap();
  }

  /**
   * Emptiest lane, and among equals the nearest.
   *
   * Spreading across depth is what makes the valley read as a place rather than a
   * row. But a child scans their sheet and looks up expecting to find their own
   * dinosaur, and the far lane renders it small and hazed - so an arrival with a
   * free choice takes the front, and the distant lanes fill only as the screen does.
   */
  private pickLane(): number {
    const counts = LANES.map(
      (_, i) => this.dinos.filter((d) => d.lane === i && d.behaviour !== "exit").length,
    );
    const fewest = Math.min(...counts);
    const candidates = counts.flatMap((c, i) => (c === fewest ? [i] : []));
    return candidates[candidates.length - 1];
  }

  /**
   * At capacity the longest-resident dinosaur turns and walks off rather than
   * vanishing. Nobody's dinosaur should blink out while they are watching it.
   */
  private enforceCap(): void {
    const active = this.dinos.filter((d) => d.behaviour !== "exit");
    if (active.length <= MAX_DINOS) return;

    active
      .sort((a, b) => a.bornAt - b.bornAt)
      .slice(0, active.length - MAX_DINOS)
      .forEach((d) => {
        d.behaviour = "exit";
        d.facing = d.x < STAGE.w / 2 ? -1 : 1;
        d.targetSpeed = 1.25;
      });
  }

  private place(dino: LiveDino): void {
    dino.holder.position.set(dino.x, LANES[dino.lane].baseline - dino.rig.footDrop * dino.scale);
  }

  private readonly tick = (ticker: Ticker): void => {
    const dt = Math.min(0.05, ticker.deltaMS / 1000);

    this.clouds.x = (this.clouds.x - dt * 3.2) % STAGE.w;

    for (const dino of [...this.dinos]) {
      this.step(dino, dt);
    }
  };

  private step(dino: LiveDino, dt: number): void {
    dino.untilChange -= dt;

    switch (dino.behaviour) {
      case "enter": {
        const inside = dino.x - dino.reachLeft > 0 && dino.x + dino.reachRight < STAGE.w;
        if (inside || dino.untilChange <= 0) {
          dino.behaviour = "wander";
          dino.targetSpeed = 0.85 + Math.random() * 0.3;
          dino.untilChange = 4 + Math.random() * 6;
        }
        break;
      }
      case "wander": {
        if (dino.untilChange <= 0) {
          // Pausing to browse is what stops ten dinosaurs looking like a parade.
          if (Math.random() < 0.45) {
            dino.behaviour = "browse";
            dino.targetSpeed = 0;
            dino.untilChange = 2.5 + Math.random() * 4;
          } else {
            dino.facing = (dino.facing * -1) as 1 | -1;
            dino.untilChange = 5 + Math.random() * 7;
          }
        }
        // Turn back rather than walk off the edge unbidden.
        if (dino.x - dino.reachLeft < 0) dino.facing = 1;
        if (dino.x + dino.reachRight > STAGE.w) dino.facing = -1;
        break;
      }
      case "browse": {
        if (dino.untilChange <= 0) {
          dino.behaviour = "wander";
          dino.targetSpeed = 0.8 + Math.random() * 0.4;
          dino.untilChange = 5 + Math.random() * 7;
        }
        break;
      }
      case "exit": {
        const gone =
          dino.facing === 1
            ? dino.x - dino.reachLeft > STAGE.w
            : dino.x + dino.reachRight < 0;
        if (gone) {
          this.remove(dino);
          return;
        }
        break;
      }
    }

    // Ease towards the target so a dinosaur leans into a stop rather than snapping.
    dino.speed += (dino.targetSpeed - dino.speed) * Math.min(1, dt * 2.2);
    dino.x += dino.facing * dino.speed * WALK_SPEED * dino.scale * dt;

    this.place(dino);
    dino.rig.update(dt, { speed: dino.speed, facing: dino.facing });
  }

  private remove(dino: LiveDino): void {
    const index = this.dinos.indexOf(dino);
    if (index >= 0) this.dinos.splice(index, 1);
    this.dinoLayer.removeChild(dino.holder);
    dino.rig.destroy();
    dino.holder.destroy({ children: true });
  }

  destroy(): void {
    this.app.ticker.remove(this.tick);
    for (const dino of [...this.dinos]) this.remove(dino);
  }
}

function lerpColour(from: number, to: number, t: number): number {
  const mix = (shift: number) => {
    const a = (from >> shift) & 0xff;
    const b = (to >> shift) & 0xff;
    return Math.round(a + (b - a) * t) << shift;
  };
  return mix(16) | mix(8) | mix(0);
}

/** Letterbox the authored stage into whatever the display actually is. */
export function fitStage(app: Application): void {
  const scale = Math.min(app.renderer.width / STAGE.w, app.renderer.height / STAGE.h);
  app.stage.scale.set(scale);
  app.stage.position.set(
    (app.renderer.width - STAGE.w * scale) / 2,
    (app.renderer.height - STAGE.h * scale) / 2,
  );
}

export { HORIZON_Y, STAGE };
