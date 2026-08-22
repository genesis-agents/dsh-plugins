/** Custom occupants for the generic browser-brand slots. */
import { MyBrandMark, MyBrandName } from './Brand.tsx'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/**
 * Fill every shipped brand slot as one declaration-aware registration set.
 * @param ctx - Client root context carrying the slot registry.
 */
export function apply(ctx: any): void {
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', () =>
      ctx.slots.inject('conversation.hero.brand.mark', function* () {
        yield ctx.slots.register({ name: 'sidebar.brand.mark' }, MyBrandMark)
        yield ctx.slots.register({ name: 'sidebar.brand.name' }, MyBrandName)
        yield ctx.slots.register({ name: 'conversation.hero.brand.mark' }, MyBrandMark)
      })))
}
