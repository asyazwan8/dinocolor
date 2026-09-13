import { Application, Container, Graphics, Sprite, Texture, type Ticker } from "pixi.js";
import { dinoScale, type DinoType } from "@/lib/sheet/types";
import { compositeRig } from "./composite";
import { DinoRig } from "./DinoRig";
import { HORIZON_Y, LANES, REFERENCE_TREE_LANE, STAGE } from "./palette";
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
const WALK_SPEED = 46;

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
  halfWidth: number;
}

export interface WorldOptions {
  rig: Rig;
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
    this.buildScenery();
    this.app.ticker.add(this.tick);
  }

  private buildScenery(): void {
    const stage = this.app.stage;
    const sprite = (canvas: HTMLCanvasElement) => new Sprite(Texture.from(canvas));

    stage.addChild(sprite(makeSky()));

    this.clouds = sprite(makeClouds());
    this.clouds.y = 30;
    stage.addChild(this.clouds);

    stage.addChild(sprite(makeMountains()));
    stage.addChild(sprite(makeHills()));
    stage.addChild(sprite(makeGround()));

    // Dinosaurs and the reference trees share one sorted layer so a near dinosaur
    // passes in front of a tree and a far one behind it. Baking the trees into a
    // flat backdrop would force every dinosaur to one side of them.
    this.dinoLayer.sortableChildren = true;
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
    const rigWidth = Math.max(...parts.map((p) => p.part.box.x + p.part.box.w));
    shadow
      .ellipse(0, rig.footDrop - 6, rigWidth * 0.34, rigWidth * 0.075)
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
    const halfWidth = (rigWidth * scale) / 2;
    const x =
      startAt === undefined
        ? facing === 1
          ? -halfWidth
          : STAGE.w + halfWidth
        : startAt * STAGE.w;

    const live: LiveDino = {
      id,
      rig,
      holder,
      shadow,
      lane,
      x,
      facing,
      speed: 1,
      targetSpeed: 1,
      behaviour: startAt === undefined ? "enter" : "wander",
      untilChange: 3 + Math.random() * 4,
      bornAt: performance.now(),
      scale,
      halfWidth,
    };

    this.dinoLayer.addChild(holder);
    this.dinos.push(live);
    this.place(live);

    this.enforceCap();
  }

  /** Prefer the emptiest lane, so arrivals spread across depth. */
  private pickLane(): number {
    const counts = LANES.map(
      (_, i) => this.dinos.filter((d) => d.lane === i && d.behaviour !== "exit").length,
    );
    const fewest = Math.min(...counts);
    const candidates = counts.flatMap((c, i) => (c === fewest ? [i] : []));
    return candidates[Math.floor(Math.random() * candidates.length)];
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
        const inside = dino.x > dino.halfWidth && dino.x < STAGE.w - dino.halfWidth;
        if (inside) {
          dino.behaviour = "wander";
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
        if (dino.x < dino.halfWidth * 0.5) dino.facing = 1;
        if (dino.x > STAGE.w - dino.halfWidth * 0.5) dino.facing = -1;
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
            ? dino.x > STAGE.w + dino.halfWidth * 1.4
            : dino.x < -dino.halfWidth * 1.4;
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
