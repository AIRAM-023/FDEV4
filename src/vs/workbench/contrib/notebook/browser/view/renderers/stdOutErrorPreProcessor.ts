/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IOutputItemDto } from 'vs/workbench/contrib/notebook/common/notebookCommon';


export function isStreamMime(mimeType: string) {
	return ['application/vnd.code.notebook.stdout', 'application/x.notebook.stdout', 'application/x.notebook.stream', 'application/vnd.code.notebook.stderr', 'application/x.notebook.stderr'].includes(mimeType);
}

/**
 * Given a stream of individual stdout outputs, this function will return the compressed lines, escaping some of the common terminal escape codes.
 * E.g. some terminal escape codes would result in the previous line getting cleared, such if we had 3 lines and
 * last line contained such a code, then the result string would be just the first two lines.
 */
export function compressOutputItemStreams(mimeType: string, outputs: IOutputItemDto[]) {
	const buffers: Uint8Array[] = [];
	let startAppending = false;

	// Pick the first set of outputs with the same mime type.
	for (const output of outputs) {
		if (output.mime === mimeType) {
			if ((buffers.length === 0 || startAppending)) {
				buffers.push(output.data.buffer);
				startAppending = true;
			}
		} else if (startAppending) {
			startAppending = false;
		}
	}
	compressStreamBuffer(buffers);
	return Buffer.concat(buffers);
}
const MOVE_CURSOR_1_LINE_COMMAND = `${String.fromCharCode(27)}[A`;
const LINE_FEED = 10;
function compressStreamBuffer(streams: Uint8Array[]) {
	streams.forEach((stream, index) => {
		if (index === 0 || stream.length < MOVE_CURSOR_1_LINE_COMMAND.length) {
			return;
		}

		const previousStream = streams[index - 1];

		// Remove the previous line if required.
		if (stream.subarray(0, MOVE_CURSOR_1_LINE_COMMAND.length).toString() === MOVE_CURSOR_1_LINE_COMMAND) {
			const lastIndexOfLineFeed = previousStream.lastIndexOf(LINE_FEED);
			if (lastIndexOfLineFeed === -1) {
				return;
			}
			streams[index - 1] = previousStream.subarray(0, lastIndexOfLineFeed);
			streams[index] = stream.subarray(MOVE_CURSOR_1_LINE_COMMAND.length);
		}
	});
	return streams;
}
