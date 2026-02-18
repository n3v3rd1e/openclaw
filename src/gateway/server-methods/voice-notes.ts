import type { GatewayRequestHandlers } from "./types.js";
import { saveVoiceNote } from "../../infra/voice-notes.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateVoiceNotesSaveParams,
} from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";

type VoiceNotesSaveParams = {
  sessionKey?: string;
  source?: "upload" | "record";
  durationMs?: number;
  transcript?: string;
  transcriptParts?: string[];
  audio: {
    mimeType?: string;
    fileName?: string;
    content: string;
  };
};

export const voiceNotesHandlers: GatewayRequestHandlers = {
  "voice-notes.save": async ({ params, respond }) => {
    if (!validateVoiceNotesSaveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid voice-notes.save params: ${formatValidationErrors(validateVoiceNotesSaveParams.errors)}`,
        ),
      );
      return;
    }

    const request = params as VoiceNotesSaveParams;

    try {
      const persisted = await saveVoiceNote({
        audioBase64: request.audio.content,
        mimeType: request.audio.mimeType,
        fileName: request.audio.fileName,
        source: request.source,
        sessionKey: request.sessionKey,
        durationMs: request.durationMs,
        transcript: request.transcript,
        transcriptParts: request.transcriptParts,
      });
      respond(true, {
        note: {
          id: persisted.metadata.id,
          createdAtMs: persisted.metadata.createdAtMs,
          source: persisted.metadata.source,
          sessionKey: persisted.metadata.sessionKey,
          durationMs: persisted.metadata.durationMs,
          mimeType: persisted.metadata.mimeType,
          fileName: persisted.metadata.fileName,
          transcript: persisted.metadata.transcript,
          transcriptLength: persisted.metadata.transcriptLength,
        },
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    }
  },
};
