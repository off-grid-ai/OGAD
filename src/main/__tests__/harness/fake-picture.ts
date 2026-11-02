/**
 * What a fake image engine writes, for every test that stands in for the bundled sd-cli or sd-server.
 *
 * The app refuses a one-colour frame as a failed run (isBlankImage): it is what a numerically broken
 * graph decodes to. So a fake engine that means "it worked" must write a real picture, with more than
 * one colour, and a test that means "the engine produced nothing" writes the blank one.
 */

/** A rendered picture: 2x1, two colours. */
export const PICTURE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGM4ISf34cMHAAtlA9VqFBqkAAAAAElFTkSuQmCC'

/** A blank frame: 8x8, one colour, as a failed GPU graph writes it. */
export const BLANK_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAD0lEQVR4nGP4jwMwDC0JALoev0Ewkwr8AAAAAElFTkSuQmCC'
