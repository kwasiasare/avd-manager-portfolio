import { IMAGE_BUILD_OPERATOR_GATED_STATES, type ImageBuildState } from '@avdmgr/shared';

/** Frontend-side Set built from @avdmgr/shared's IMAGE_BUILD_OPERATOR_GATED_STATES — same source of truth app/api/src/lib/imageBuildStateMachine.ts's OPERATOR_GATED_STATES derives from, so the wizard's "Advance" button appears in exactly the states the API will actually accept it in. */
export const OPERATOR_GATED_IMAGE_BUILD_STATES: ReadonlySet<ImageBuildState> = new Set(IMAGE_BUILD_OPERATOR_GATED_STATES);
