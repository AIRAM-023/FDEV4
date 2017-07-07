/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import 'vs/css!./watermark';
import { $, Builder } from 'vs/base/browser/builder';
import { IDisposable, dispose } from 'vs/base/common/lifecycle';
import { assign } from 'vs/base/common/objects';
import { isMacintosh } from 'vs/base/common/platform';
import { IKeybindingService } from 'vs/platform/keybinding/common/keybinding';
import * as nls from 'vs/nls';
import { Registry } from 'vs/platform/registry/common/platform';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from 'vs/platform/configuration/common/configurationRegistry';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { IWorkbenchContribution, IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from 'vs/workbench/common/contributions';
import { ILifecycleService } from 'vs/platform/lifecycle/common/lifecycle';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { OpenRecentAction } from 'vs/workbench/electron-browser/actions';
import { GlobalNewUntitledFileAction, OpenFileAction } from 'vs/workbench/parts/files/browser/fileActions';
import { OpenFolderAction, OpenFileFolderAction } from 'vs/workbench/browser/actions/fileActions';
import { ShowAllCommandsAction } from 'vs/workbench/parts/quickopen/browser/commandsHandler';
import { Parts, IPartService } from 'vs/workbench/services/part/common/partService';
import { StartAction } from 'vs/workbench/parts/debug/browser/debugActions';
import { FindInFilesActionId } from 'vs/workbench/parts/search/common/constants';
import { ToggleTerminalAction } from 'vs/workbench/parts/terminal/electron-browser/terminalActions';

interface WatermarkEntry {
	text: string;
	ids: string[];
	mac?: boolean;
}

const showCommands: WatermarkEntry = {
	text: nls.localize('watermark.showCommands', "Show All Commands"),
	ids: [ShowAllCommandsAction.ID]
};
const openFileNonMacOnly: WatermarkEntry = {
	text: nls.localize('watermark.openFile', "Open File"),
	ids: [OpenFileAction.ID],
	mac: false
};
const openFolderNonMacOnly: WatermarkEntry = {
	text: nls.localize('watermark.openFolder', "Open Folder"),
	ids: [OpenFolderAction.ID],
	mac: false
};
const openFileOrFolderMacOnly: WatermarkEntry = {
	text: nls.localize('watermark.openFileFolder', "Open File or Folder"),
	ids: [OpenFileFolderAction.ID],
	mac: true
};
const openRecent: WatermarkEntry = {
	text: nls.localize('watermark.openRecent', "Open Recent"),
	ids: [OpenRecentAction.ID]
};
const newUntitledFile: WatermarkEntry = {
	text: nls.localize('watermark.newUntitledFile', "New Untitled File"),
	ids: [GlobalNewUntitledFileAction.ID]
};
const newUntitledFileMacOnly: WatermarkEntry = assign({ mac: true }, newUntitledFile);
const toggleTerminal: WatermarkEntry = {
	text: nls.localize({ key: 'watermark.toggleTerminal', comment: ['toggle is a verb here'] }, "Toggle Terminal"),
	ids: [ToggleTerminalAction.ID]
};

const findInFiles: WatermarkEntry = {
	text: nls.localize('watermark.findInFiles', "Find in Files"),
	ids: [FindInFilesActionId]
};
const startDebugging: WatermarkEntry = {
	text: nls.localize('watermark.startDebugging', "Start Debugging"),
	ids: [StartAction.ID]
};
const quickOpen: WatermarkEntry = {
	text: nls.localize('workbench.action.quickOpen', "Quick Open"),
	ids: ['workbench.action.quickOpen']
};

const noFolderEntries = [
	showCommands,
	openFileNonMacOnly,
	openFolderNonMacOnly,
	openFileOrFolderMacOnly,
	openRecent,
	newUntitledFileMacOnly,
	toggleTerminal,
	quickOpen
];

const folderEntries = [
	showCommands,
	findInFiles,
	startDebugging,
	toggleTerminal
];

const UNBOUND = nls.localize('watermark.unboundCommand', "unbound");

export class WatermarkContribution implements IWorkbenchContribution {

	private toDispose: IDisposable[] = [];
	private watermark: Builder;
	private enabled: boolean;

	constructor(
		@ILifecycleService lifecycleService: ILifecycleService,
		@IPartService private partService: IPartService,
		@IKeybindingService private keybindingService: IKeybindingService,
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@ITelemetryService private telemetryService: ITelemetryService,
		@IConfigurationService private configurationService: IConfigurationService
	) {
		lifecycleService.onShutdown(this.dispose, this);
		this.partService.joinCreation().then(() => {
			this.enabled = this.configurationService.lookup<boolean>('workbench.tips.enabled').value;
			if (this.enabled) {
				this.create();
			}
		});
		this.configurationService.onDidUpdateConfiguration(e => {
			const enabled = this.configurationService.lookup<boolean>('workbench.tips.enabled').value;
			if (enabled !== this.enabled) {
				this.enabled = enabled;
				if (this.enabled) {
					this.create();
				} else {
					this.destroy();
				}
			}
		});
	}

	public getId() {
		return 'vs.watermark';
	}

	private create(): void {
		const container = this.partService.getContainer(Parts.EDITOR_PART);
		container.classList.add('has-watermark');

		this.watermark = $()
			.div({ 'class': 'watermark' });
		const box = $(this.watermark)
			.div({ 'class': 'watermark-box' });
		const folder = this.contextService.hasWorkspace();
		const selected = folder ? folderEntries : noFolderEntries
			.filter(entry => !('mac' in entry) || entry.mac === isMacintosh);
		const update = () => {
			const builder = $(box);
			builder.clearChildren();
			selected.map(entry => {
				builder.element('dl', {}, dl => {
					dl.element('dt', {}, dt => dt.text(entry.text));
					dl.element('dd', {}, dd => dd.innerHtml(
						entry.ids
							.map(id => {
								let k = this.keybindingService.lookupKeybinding(id);
								if (k) {
									return `<span class="shortcuts">${k.getLabel()}</span>`;
								}
								return `<span class="unbound">${UNBOUND}</span>`;
							})
							.join(' / ')
					));
				});
			});
		};
		const layout = () => {
			const { height } = container.getBoundingClientRect();
			container.classList[height <= 478 ? 'add' : 'remove']('max-height-478px');
		};
		update();
		this.watermark.build(container.firstElementChild as HTMLElement, 0);
		layout();
		this.toDispose.push(this.keybindingService.onDidUpdateKeybindings(update));
		this.toDispose.push(this.partService.onEditorLayout(layout));
	}

	private destroy(): void {
		if (this.watermark) {
			this.watermark.destroy();
			this.partService.getContainer(Parts.EDITOR_PART).classList.remove('has-watermark');
			this.dispose();
		}
	}

	public dispose(): void {
		this.toDispose = dispose(this.toDispose);
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench)
	.registerWorkbenchContribution(WatermarkContribution);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration)
	.registerConfiguration({
		'id': 'workbench',
		'order': 7,
		'title': nls.localize('workbenchConfigurationTitle', "Workbench"),
		'properties': {
			'workbench.tips.enabled': {
				'type': 'boolean',
				'default': true,
				'description': nls.localize('tips.enabled', "When enabled, will show the watermark tips when no editor is open.")
			},
		}
	});