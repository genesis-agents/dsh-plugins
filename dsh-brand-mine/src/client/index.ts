/** Custom occupants for the generic browser-brand slots. */
import { MyBrandMark, MyBrandName } from './Brand.tsx'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/**
 * Rank that wins a contested brand seat.
 *
 * These are SINGLE slots: a second registration at the same priority is not a
 * second occupant but a collision, and the loader refuses the whole plugin
 * rather than picking one. That is not hypothetical — `@linxin666/dsh-liangshen`
 * takes `sidebar.brand.mark` from 0.2.9 onward, and a profile pinned to
 * `^0.2.1` picked it up on a fresh install, which took the entire UI down with
 * "single slot already has a registration at priority 0".
 *
 * Lower renders, so -1 states the intent this plugin exists for: when something
 * else claims the brand seat, mine is the one that shows. Being explicit also
 * means the next plugin to claim it collides with a stated rank rather than
 * with an accident of load order.
 */
const SHADOW = -1

/**
 * Fill every shipped brand slot as one declaration-aware registration set.
 * @param ctx - Client root context carrying the slot registry.
 */
export function apply(ctx: any): void {
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', () =>
      ctx.slots.inject('conversation.hero.brand.mark', function* () {
        yield ctx.slots.register({ name: 'sidebar.brand.mark', priority: SHADOW }, MyBrandMark)
        yield ctx.slots.register({ name: 'sidebar.brand.name', priority: SHADOW }, MyBrandName)
        yield ctx.slots.register({ name: 'conversation.hero.brand.mark', priority: SHADOW }, MyBrandMark)
      })))
}
