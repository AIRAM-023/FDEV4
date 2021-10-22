/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from 'vs/base/common/event';
import { Disposable } from 'vs/base/common/lifecycle';
import { ILocalPtyService } from 'vs/platform/terminal/electron-sandbox/terminal';
import { IProcessDataEvent, ITerminalChildProcess, ITerminalLaunchError, IProcessProperty, IProcessPropertyMap, ProcessPropertyType, ProcessCapability, IProcessReadyEvent } from 'vs/platform/terminal/common/terminal';
import { IPtyHostProcessReplayEvent } from 'vs/platform/terminal/common/terminalProcess';

/**
 * Responsible for establishing and maintaining a connection with an existing terminal process
 * created on the local pty host.
 */
export class LocalPty extends Disposable implements ITerminalChildProcess {
	private _inReplay = false;
	private _properties: IProcessPropertyMap = {
		cwd: '',
		initialCwd: '',
		fixedDimensions: { cols: undefined, rows: undefined },
		title: '',
		shellType: undefined,
		hasChildProcesses: true,
		resolvedShellLaunchConfig: {},
		overrideDimensions: undefined,
		exit: undefined,
	};
	private _capabilities: ProcessCapability[] = [];
	get capabilities(): ProcessCapability[] { return this._capabilities; }
	private readonly _onProcessData = this._register(new Emitter<IProcessDataEvent | string>());
	readonly onProcessData = this._onProcessData.event;
	private readonly _onProcessReplay = this._register(new Emitter<IPtyHostProcessReplayEvent>());
	readonly onProcessReplay = this._onProcessReplay.event;
	private readonly _onProcessReady = this._register(new Emitter<IProcessReadyEvent>());
	readonly onProcessReady = this._onProcessReady.event;
	private readonly _onDidChangeProperty = this._register(new Emitter<IProcessProperty<any>>());
	readonly onDidChangeProperty = this._onDidChangeProperty.event;

	constructor(
		readonly id: number,
		readonly shouldPersist: boolean,
		@ILocalPtyService private readonly _localPtyService: ILocalPtyService
	) {
		super();
	}

	start(): Promise<ITerminalLaunchError | undefined> {
		return this._localPtyService.start(this.id);
	}
	detach(): Promise<void> {
		return this._localPtyService.detachFromProcess(this.id);
	}
	shutdown(immediate: boolean): void {
		this._localPtyService.shutdown(this.id, immediate);
	}
	async processBinary(data: string): Promise<void> {
		if (this._inReplay) {
			return;
		}
		return this._localPtyService.processBinary(this.id, data);
	}
	input(data: string): void {
		if (this._inReplay) {
			return;
		}
		this._localPtyService.input(this.id, data);
	}
	resize(cols: number, rows: number): void {
		if (this._inReplay) {
			return;
		}
		this._localPtyService.resize(this.id, cols, rows);
	}
	async getInitialCwd(): Promise<string> {
		return this._properties.initialCwd;
	}
	async getCwd(): Promise<string> {
		return this._properties.cwd || this._properties.initialCwd;
	}
	async refreshProperty<T extends ProcessPropertyType>(type: ProcessPropertyType): Promise<IProcessPropertyMap[T]> {
		return this._localPtyService.refreshProperty(this.id, type);
	}
	async updateProperty<T extends ProcessPropertyType>(type: ProcessPropertyType, value: IProcessPropertyMap[T]): Promise<void> {
		return this._localPtyService.updateProperty(this.id, type, value);
	}
	getLatency(): Promise<number> {
		// TODO: The idea here was to add the result plus the time it took to get the latency
		return this._localPtyService.getLatency(this.id);
	}
	acknowledgeDataEvent(charCount: number): void {
		if (this._inReplay) {
			return;
		}
		this._localPtyService.acknowledgeDataEvent(this.id, charCount);
	}
	setUnicodeVersion(version: '6' | '11'): Promise<void> {
		return this._localPtyService.setUnicodeVersion(this.id, version);
	}

	handleData(e: string | IProcessDataEvent) {
		this._onProcessData.fire(e);
	}
	handleReady(e: IProcessReadyEvent) {
		this._capabilities = e.capabilities;
		this._onProcessReady.fire(e);
	}
	handleDidChangeProperty({ type, value }: IProcessProperty<any>) {
		switch (type) {
			case ProcessPropertyType.Cwd:
				this._properties.cwd = value;
				break;
			case ProcessPropertyType.InitialCwd:
				this._properties.initialCwd = value;
				break;
		}
		this._onDidChangeProperty.fire({ type, value });
	}

	async handleReplay(e: IPtyHostProcessReplayEvent) {
		try {
			this._inReplay = true;
			for (const innerEvent of e.events) {
				if (innerEvent.cols !== 0 || innerEvent.rows !== 0) {
					// never override with 0x0 as that is a marker for an unknown initial size
					this._onDidChangeProperty.fire({ type: ProcessPropertyType.OverrideDimensions, value: { cols: innerEvent.cols, rows: innerEvent.rows, forceExactSize: true } });
				}
				const e: IProcessDataEvent = { data: innerEvent.data, trackCommit: true };
				this._onProcessData.fire(e);
				await e.writePromise;
			}
		} finally {
			this._inReplay = false;
		}

		// remove size override
		this._onDidChangeProperty.fire({ type: ProcessPropertyType.OverrideDimensions, value: undefined });
	}

	handleOrphanQuestion() {
		this._localPtyService.orphanQuestionReply(this.id);
	}
}
