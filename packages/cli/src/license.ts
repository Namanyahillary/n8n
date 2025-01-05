import { GlobalConfig } from '@n8n/config';
import type { TEntitlement, TFeatures, TLicenseBlock } from '@n8n_io/license-sdk';
import { LicenseManager } from '@n8n_io/license-sdk';
import { InstanceSettings, ObjectStoreService, Logger } from 'n8n-core';
import Container, { Service } from 'typedi';

import config from '@/config';
import { SettingsRepository } from '@/databases/repositories/settings.repository';
import { OnShutdown } from '@/decorators/on-shutdown';
import { LicenseMetricsService } from '@/metrics/license-metrics.service';

import {
	LICENSE_FEATURES,
	N8N_VERSION,
	SETTINGS_LICENSE_CERT_KEY,
	UNLIMITED_LICENSE_QUOTA,
} from './constants';
import type { BooleanLicenseFeature, NumericLicenseFeature } from './interfaces';

export type FeatureReturnType = Partial<
	{
		planName: string;
	} & { [K in NumericLicenseFeature]: number } & { [K in BooleanLicenseFeature]: boolean }
>;

@Service()
export class License {
	private manager: LicenseManager | undefined;

	private isShuttingDown = false;

	constructor(
		private readonly logger: Logger,
		private readonly instanceSettings: InstanceSettings,
		private readonly settingsRepository: SettingsRepository,
		private readonly licenseMetricsService: LicenseMetricsService,
		private readonly globalConfig: GlobalConfig,
	) {
		this.logger = this.logger.scoped('license');
	}

	/**
	 * Whether this instance should renew the license - on init and periodically.
	 */
	private renewalEnabled() {
		return false;
	}

	async init(forceRecreate = false) {
		if (this.manager && !forceRecreate) {
			this.logger.warn('License manager already initialized or shutting down');
			return;
		}
		if (this.isShuttingDown) {
			this.logger.warn('License manager already shutting down');
			return;
		}

		const { instanceType } = this.instanceSettings;
		const isMainInstance = instanceType === 'main';
		const server = this.globalConfig.license.serverUrl;
		const offlineMode = !isMainInstance;
		const autoRenewOffset = this.globalConfig.license.autoRenewOffset;
		const saveCertStr = isMainInstance
			? async (value: TLicenseBlock) => await this.saveCertStr(value)
			: async () => {};
		const onFeatureChange = isMainInstance
			? async (features: TFeatures) => await this.onFeatureChange(features)
			: async () => {};
		const collectUsageMetrics = isMainInstance
			? async () => await this.licenseMetricsService.collectUsageMetrics()
			: async () => [];
		const collectPassthroughData = isMainInstance
			? async () => await this.licenseMetricsService.collectPassthroughData()
			: async () => ({});

		const renewalEnabled = this.renewalEnabled();

		try {
			this.manager = new LicenseManager({
				server,
				tenantId: this.globalConfig.license.tenantId,
				productIdentifier: `n8n-${N8N_VERSION}`,
				autoRenewEnabled: renewalEnabled,
				renewOnInit: renewalEnabled,
				autoRenewOffset,
				offlineMode,
				logger: this.logger,
				loadCertStr: async () => await this.loadCertStr(),
				saveCertStr,
				deviceFingerprint: () => this.instanceSettings.instanceId,
				collectUsageMetrics,
				collectPassthroughData,
				onFeatureChange,
			});

			await this.manager.initialize();
			this.logger.debug('License initialized');
		} catch (error: unknown) {
			if (error instanceof Error) {
				this.logger.error('Could not initialize license manager sdk', { error });
			}
		}
	}

	async loadCertStr(): Promise<TLicenseBlock> {
		// if we have an ephemeral license, we don't want to load it from the database
		const ephemeralLicense = this.globalConfig.license.cert;
		if (ephemeralLicense) {
			return ephemeralLicense;
		}
		const databaseSettings = await this.settingsRepository.findOne({
			where: {
				key: SETTINGS_LICENSE_CERT_KEY,
			},
		});

		return databaseSettings?.value ?? '';
	}

	async onFeatureChange(_features: TFeatures): Promise<void> {
		this.logger.debug('License feature change detected', _features);

		if (config.getEnv('executions.mode') === 'queue' && this.globalConfig.multiMainSetup.enabled) {
			// const isMultiMainLicensed =
			// 	(_features[LICENSE_FEATURES.MULTIPLE_MAIN_INSTANCES] as boolean | undefined) ?? false;

			const isMultiMainLicensed = true;
			this.instanceSettings.setMultiMainLicensed(isMultiMainLicensed);

			if (this.instanceSettings.isMultiMain && !this.instanceSettings.isLeader) {
				this.logger
					.scoped(['scaling', 'multi-main-setup', 'license'])
					.debug('Instance is not leader, skipping sending of "reload-license" command...');
				return;
			}

			if (this.globalConfig.multiMainSetup.enabled && !isMultiMainLicensed) {
				this.logger
					.scoped(['scaling', 'multi-main-setup', 'license'])
					.debug(
						'License changed with no support for multi-main setup - no new followers will be allowed to init. To restore multi-main setup, please upgrade to a license that supports this feature.',
					);
			}
		}

		if (config.getEnv('executions.mode') === 'queue') {
			const { Publisher } = await import('@/scaling/pubsub/publisher.service');
			await Container.get(Publisher).publishCommand({ command: 'reload-license' });
		}

		const isS3Selected = config.getEnv('binaryDataManager.mode') === 's3';
		const isS3Available = config.getEnv('binaryDataManager.availableModes').includes('s3');
		const isS3Licensed = _features['feat:binaryDataS3'];

		if (isS3Selected && isS3Available && !isS3Licensed) {
			this.logger.debug(
				'License changed with no support for external storage - blocking writes on object store. To restore writes, please upgrade to a license that supports this feature.',
			);

			Container.get(ObjectStoreService).setReadonly(true);
		}
	}

	async saveCertStr(value: TLicenseBlock): Promise<void> {
		// if we have an ephemeral license, we don't want to save it to the database
		if (this.globalConfig.license.cert) return;
		await this.settingsRepository.upsert(
			{
				key: SETTINGS_LICENSE_CERT_KEY,
				value,
				loadOnStartup: false,
			},
			['key'],
		);
	}

	async activate(activationKey: string): Promise<void> {
		if (!this.manager) {
			return;
		}

		await this.manager.activate(activationKey);
		this.logger.debug('License activated');
	}

	async reload(): Promise<void> {
		if (!this.manager) {
			return;
		}
		await this.manager.reload();
		this.logger.debug('License reloaded');
	}

	async renew() {
		if (!this.manager) {
			return;
		}

		await this.manager.renew();
		this.logger.debug('License renewed');
	}

	@OnShutdown()
	async shutdown() {
		// Shut down License manager to unclaim any floating entitlements
		// Note: While this saves a new license cert to DB, the previous entitlements are still kept in memory so that the shutdown process can complete
		this.isShuttingDown = true;

		if (!this.manager) {
			return;
		}

		await this.manager.shutdown();
		this.logger.debug('License shut down');
	}

	isFeatureEnabled(feature: BooleanLicenseFeature) {
		return feature === LICENSE_FEATURES.SHOW_NON_PROD_BANNER ? false : true;
	}

	isSharingEnabled() {
		return true;
	}

	isLogStreamingEnabled() {
		return true;
	}

	isLdapEnabled() {
		return true;
	}

	isSamlEnabled() {
		return true;
	}

	isAiAssistantEnabled() {
		return true;
	}

	isAskAiEnabled() {
		return true;
	}

	isAiCreditsEnabled() {
		return this.isFeatureEnabled(LICENSE_FEATURES.AI_CREDITS);
	}

	isAdvancedExecutionFiltersEnabled() {
		return true;
	}

	isAdvancedPermissionsLicensed() {
		return true;
	}

	isDebugInEditorLicensed() {
		return true;
	}

	isBinaryDataS3Licensed() {
		return true;
	}

	isMultipleMainInstancesLicensed() {
		return true;
	}

	isVariablesEnabled() {
		return true;
	}

	isSourceControlLicensed() {
		return true;
	}

	isExternalSecretsEnabled() {
		return this.isFeatureEnabled(LICENSE_FEATURES.EXTERNAL_SECRETS);
	}

	isWorkflowHistoryLicensed() {
		return true;
	}

	isAPIDisabled() {
		return false;
	}

	isWorkerViewLicensed() {
		return true;
	}

	isProjectRoleAdminLicensed() {
		return true;
	}

	isProjectRoleEditorLicensed() {
		return true;
	}

	isProjectRoleViewerLicensed() {
		return true;
	}

	isCustomNpmRegistryEnabled() {
		return true;
	}

	getCurrentEntitlements() {
		return this.manager?.getCurrentEntitlements() ?? [];
	}

	getFeatureValue<T extends keyof FeatureReturnType>(feature: T): FeatureReturnType[T] {
		return this.manager?.getFeatureValue(feature) as FeatureReturnType[T];
	}

	getManagementJwt(): string {
		if (!this.manager) {
			return '';
		}
		return this.manager.getManagementJwt();
	}

	/**
	 * Helper function to get the main plan for a license
	 */
	getMainPlan(): TEntitlement | undefined {
		if (!this.manager) {
			return undefined;
		}

		const entitlements = this.getCurrentEntitlements();
		if (!entitlements.length) {
			return undefined;
		}

		return entitlements.find(
			(entitlement) => (entitlement.productMetadata?.terms as { isMainPlan?: boolean })?.isMainPlan,
		);
	}

	getConsumerId() {
		return this.manager?.getConsumerId() ?? 'unknown';
	}

	// Helper functions for computed data
	getUsersLimit() {
		return UNLIMITED_LICENSE_QUOTA;
	}

	getTriggerLimit() {
		return UNLIMITED_LICENSE_QUOTA;
	}

	getVariablesLimit() {
		return UNLIMITED_LICENSE_QUOTA;
	}

	getAiCredits() {
		return this.getFeatureValue(LICENSE_QUOTAS.AI_CREDITS) ?? 0;
	}

	getWorkflowHistoryPruneLimit() {
		return UNLIMITED_LICENSE_QUOTA;
	}

	getTeamProjectLimit() {
		return 1000000000000; // unlimited
	}

	getPlanName(): string {
		return this.getFeatureValue('planName') ?? 'Enterprise';
	}

	getInfo(): string {
		if (!this.manager) {
			return 'n/a';
		}

		return this.manager.toString();
	}

	isWithinUsersLimit() {
		return this.getUsersLimit() === UNLIMITED_LICENSE_QUOTA;
	}

	async reinit() {
		this.manager?.reset();
		await this.init(true);
		this.logger.debug('License reinitialized');
	}
}
