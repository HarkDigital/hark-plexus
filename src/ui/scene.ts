/*
 * Reference-counted "the scene is covered" holds. The phone-landscape rotate
 * card and the mobile menu sheet each stop the WebGL frame while they cover
 * it: the engine skips rendering (engine.paused), the last frame stays behind
 * the frosted sheet, perfectly still, and an unseen scene never burns battery.
 *
 * Holds may be taken before the engine exists; they apply once bindScene()
 * runs.
 */

interface Pausable {
  paused: boolean
}

let target: Pausable | null = null
const holds = new Set<string>()

const apply = () => {
  if (target) target.paused = holds.size > 0
}

export function bindScene(engine: Pausable) {
  target = engine
  apply()
}

export function holdScene(key: string) {
  holds.add(key)
  apply()
}

export function releaseScene(key: string) {
  if (holds.delete(key)) apply()
}

/** true while anything holds the scene */
export function sceneHeld() {
  return holds.size > 0
}
