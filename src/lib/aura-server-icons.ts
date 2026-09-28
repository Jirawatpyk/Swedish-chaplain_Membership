/**
 * AURA 5.9: icon names given as strings (`<Icon name="lock" />`) need
 * `registerIcons` from 6.0. `@jirawatpyk/aura-react/server` keeps its own
 * registry, apart from the client one registered in `AuraBridge`, so the root
 * layout imports this module once for Server Components.
 */
import { registerIcons } from '@jirawatpyk/aura-react/server';
import { allIcons } from '@jirawatpyk/aura-react/icons';

registerIcons(allIcons);
