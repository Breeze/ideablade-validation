// Copies shared repository assets into the npm package folder before building.
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync(new URL('../schema/', import.meta.url), { recursive: true });
copyFileSync(new URL('../../spec/validation-metadata.schema.json', import.meta.url), new URL('../schema/validation-metadata.schema.json', import.meta.url));
copyFileSync(new URL('../../LICENSE', import.meta.url), new URL('../LICENSE', import.meta.url));
