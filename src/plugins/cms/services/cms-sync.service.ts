import { Inject, Injectable, OnApplicationBootstrap } from "@nestjs/common";
import {
  ChannelService,
  Collection,
  CollectionService,
  LanguageCode,
  Logger,
  ProcessContext,
  Product,
  ProductVariant,
  RequestContext,
  RequestContextService,
  TransactionalConnection,
} from "@vendure/core";
import { In } from "typeorm";
import { CMS_PLUGIN_OPTIONS, loggerCtx } from "../constants";
import { PluginInitOptions, SyncJobData, SyncResponse } from "../types";
import { TranslationUtils } from "../utils/translation.utils";
import { SanityService } from "./sanity.service";

@Injectable()
export class CmsSyncService implements OnApplicationBootstrap {
  private readonly translationUtils = new TranslationUtils();

  constructor(
    @Inject(CMS_PLUGIN_OPTIONS) private options: PluginInitOptions,
    private readonly connection: TransactionalConnection,
    private readonly channelService: ChannelService,
    private readonly collectionService: CollectionService,
    private readonly requestContextService: RequestContextService,
    private readonly sanityService: SanityService,
    private processContext: ProcessContext,
  ) {}

  async onApplicationBootstrap() {
    if (this.processContext.isWorker) {
      Logger.info(`[${loggerCtx}] CMS Sync Service initialized`);
    }
  }

  private async getDefaultLanguageCode(): Promise<LanguageCode> {
    const defaultChannel = await this.channelService.getDefaultChannel();
    return defaultChannel.defaultLanguageCode;
  }

  // ---------- HELPERS FOR RELATIONS ----------

  async findCollectionsForVariant(
    ctx: RequestContext,
    variantId: string | number,
  ): Promise<Collection[]> {
    try {
      const collections = await this.collectionService.findAll(ctx);
      const result: Collection[] = [];

      for (const collection of collections.items) {
        const variantIds =
          await this.collectionService.getCollectionProductVariantIds(
            collection,
            ctx,
          );
        if (variantIds.some((id) => id.toString() === variantId.toString())) {
          result.push(collection);
        }
      }

      return result;
    } catch (error) {
      Logger.error(
        `Failed to find collections for variant ${variantId}`,
        String(error),
      );
      return [];
    }
  }

  async findVariantsForCollection(
    ctx: RequestContext,
    collectionId: string | number,
  ): Promise<ProductVariant[]> {
    try {
      const collection = await this.connection.rawConnection
        .getRepository(Collection)
        .findOne({ where: { id: collectionId as any } });

      if (!collection) return [];

      const variantIds =
        await this.collectionService.getCollectionProductVariantIds(
          collection,
          ctx,
        );
      if (variantIds.length === 0) return [];

      return await this.connection.rawConnection
        .getRepository(ProductVariant)
        .find({
          where: { id: In(variantIds) },
          relations: ["translations", "product", "product.translations"],
          order: { id: "ASC" },
        });
    } catch (error) {
      Logger.error(
        `Failed to find variants for collection ${collectionId}`,
        String(error),
      );
      return [];
    }
  }

  // ---------- GENERIC BULK SYNC ----------

  private async syncAllEntitiesToCmsGeneric<T extends { id: any }>(
    entityType: "Product" | "ProductVariant" | "Collection",
    repository: any,
    syncMethod: (jobData: SyncJobData) => Promise<SyncResponse>,
  ) {
    const start = Date.now();
    let successCount = 0;
    let errorCount = 0;
    const errors: {
      entityId: number | string;
      error: string;
      attempts: number;
    }[] = [];

    try {
      Logger.info(
        `[${loggerCtx}] Starting bulk sync for ${entityType.toLowerCase()}s`,
      );

      const entities = await this.connection.rawConnection
        .getRepository(repository)
        .find({
          relations: ["translations"],
          order: { id: "ASC" },
        });

      const total = entities.length;
      if (total === 0) {
        return {
          success: true,
          totalEntities: 0,
          successCount: 0,
          errorCount: 0,
          errors: [],
        };
      }

      interface Job {
        entity: T;
        attempts: number;
        maxAttempts: number;
        lastError?: string;
      }

      const queue: Job[] = entities.map((e) => ({
        entity: e as T,
        attempts: 0,
        maxAttempts: 5,
      }));

      const BATCH = 10;
      let processed = 0;

      while (queue.length > 0) {
        const batch = queue.splice(0, BATCH);

        const results = await Promise.allSettled(
          batch.map(async (job) => {
            job.attempts++;
            try {
              await syncMethod({
                entityType,
                entityId: job.entity.id,
                operationType: "update",
                timestamp: new Date().toISOString(),
                retryCount: job.attempts - 1,
              });
              return { job, success: true as const };
            } catch (error) {
              const msg =
                error instanceof Error ? error.message : "Unknown error";
              job.lastError = msg;
              return { job, success: false as const, error: msg };
            }
          }),
        );

        for (const r of results) {
          if (r.status !== "fulfilled") continue;
          const { job, success, error } = r.value;

          if (success) {
            successCount++;
            processed++;
          } else {
            if (job.attempts < job.maxAttempts) {
              queue.push(job);
            } else {
              errorCount++;
              processed++;
              errors.push({
                entityId: job.entity.id,
                error: `Failed after ${job.maxAttempts} attempts. Last error: ${job.lastError}`,
                attempts: job.attempts,
              });
            }
          }
        }

        Logger.info(
          `[${loggerCtx}] ${entityType} progress: ${processed}/${total}, success=${successCount}, errors=${errorCount}, remaining=${queue.length}`,
        );
      }

      const duration = Date.now() - start;
      Logger.info(
        `[${loggerCtx}] Bulk ${entityType} sync finished in ${duration}ms: ${successCount}/${total} ok, ${errorCount} failed`,
      );

      return {
        success: errorCount === 0,
        totalEntities: total,
        successCount,
        errorCount,
        errors,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      Logger.error(
        `[${loggerCtx}] Bulk ${entityType} sync failed: ${msg}`,
        error instanceof Error ? error.stack : "",
      );
      return {
        success: false,
        totalEntities: 0,
        successCount,
        errorCount: errorCount + 1,
        errors: [
          ...errors,
          { entityId: -1, error: msg, attempts: 1 },
        ],
      };
    }
  }

  // ---------- BULK ENTRYPOINTS ----------

  async syncAllProductsToCms() {
    const result = await this.syncAllEntitiesToCmsGeneric(
      "Product",
      Product,
      this.syncProductToCms.bind(this),
    );
    return {
      success: result.success,
      totalProducts: result.totalEntities,
      successCount: result.successCount,
      errorCount: result.errorCount,
      errors: result.errors.map((e) => ({
        productId: e.entityId,
        error: e.error,
        attempts: e.attempts,
      })),
    };
  }

  async syncAllProductVariantsToCms() {
    const result = await this.syncAllEntitiesToCmsGeneric(
      "ProductVariant",
      ProductVariant,
      this.syncVariantToCms.bind(this),
    );
    return {
      success: result.success,
      totalProductVariants: result.totalEntities,
      successCount: result.successCount,
      errorCount: result.errorCount,
      errors: result.errors.map((e) => ({
        productVariantId: e.entityId,
        error: e.error,
        attempts: e.attempts,
      })),
    };
  }

  async syncAllCollectionsToCms() {
    const result = await this.syncAllEntitiesToCmsGeneric(
      "Collection",
      Collection,
      this.syncCollectionToCms.bind(this),
    );
    return {
      success: result.success,
      totalCollections: result.totalEntities,
      successCount: result.successCount,
      errorCount: result.errorCount,
      errors: result.errors.map((e) => ({
        collectionId: e.entityId,
        error: e.error,
        attempts: e.attempts,
      })),
    };
  }

  async syncAllEntityTypes() {
    await this.syncAllProductsToCms();
    await this.syncAllProductVariantsToCms();
    await this.syncAllCollectionsToCms();
  }

  // ---------- PER-ENTITY SYNC ----------

  async syncProductToCms(jobData: SyncJobData): Promise<SyncResponse> {
    try {
      const product = await this.connection.rawConnection
        .getRepository(Product)
        .findOne({
          where: { id: jobData.entityId },
          relations: { translations: true },
        });

      if (!product) {
        throw new Error(`Product ${jobData.entityId} not found`);
      }

      const defaultLanguageCode = await this.getDefaultLanguageCode();
      const productSlug = this.translationUtils.getSlugByLanguage(
        product.translations,
        defaultLanguageCode,
      );

      await this.sanityService.syncProduct({
        product,
        defaultLanguageCode,
        operationType: jobData.operationType,
        productSlug,
      });

      return {
        success: true,
        message: `Product ${jobData.operationType} synced`,
        timestamp: new Date(),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      Logger.error(`[${loggerCtx}] Product sync failed: ${msg}`);
      return { success: false, message: `Product sync failed: ${msg}` };
    }
  }

  async syncVariantToCms(jobData: SyncJobData): Promise<SyncResponse> {
    try {
      const defaultLanguageCode = await this.getDefaultLanguageCode();
      const ctx = await this.requestContextService.create({
        apiType: "admin",
        languageCode: defaultLanguageCode,
        channelOrToken: await this.channelService.getDefaultChannel(),
      });

      const variant = await this.connection.rawConnection
        .getRepository(ProductVariant)
        .findOne({
          where: { id: jobData.entityId },
          relations: ["translations", "product", "product.translations"],
        });

      if (!variant) {
        throw new Error(`Variant ${jobData.entityId} not found`);
      }

      const productSlug = this.translationUtils.getSlugByLanguage(
        variant.product.translations,
        defaultLanguageCode,
      );
      const variantSlug = productSlug
        ? `${productSlug}-variant-${variant.id}`
        : `variant-${variant.id}`;

      const collections = await this.findCollectionsForVariant(ctx, variant.id);

      await this.sanityService.syncProductVariant({
        variant,
        defaultLanguageCode,
        operationType: jobData.operationType,
        variantSlug,
        collections,
      });

      return {
        success: true,
        message: `Variant ${jobData.operationType} synced`,
        timestamp: new Date(),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      Logger.error(`[${loggerCtx}] Variant sync failed: ${msg}`);
      return { success: false, message: `Variant sync failed: ${msg}` };
    }
  }

  async syncCollectionToCms(jobData: SyncJobData): Promise<SyncResponse> {
    try {
      const defaultLanguageCode = await this.getDefaultLanguageCode();
      const ctx = await this.requestContextService.create({
        apiType: "admin",
        languageCode: defaultLanguageCode,
        channelOrToken: await this.channelService.getDefaultChannel(),
      });

      const collection = await this.connection.rawConnection
        .getRepository(Collection)
        .findOne({
          where: { id: jobData.entityId },
          relations: ["translations"],
        });

      if (!collection) {
        throw new Error(`Collection ${jobData.entityId} not found`);
      }

      const collectionSlug = this.translationUtils.getSlugByLanguage(
        collection.translations,
        defaultLanguageCode,
      );

      // we no longer push variant references from collection → Sanity
      await this.sanityService.syncCollection({
        collection,
        defaultLanguageCode,
        operationType: jobData.operationType,
        collectionSlug,
      });

      return {
        success: true,
        message: `Collection ${jobData.operationType} synced`,
        timestamp: new Date(),
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      Logger.error(`[${loggerCtx}] Collection sync failed: ${msg}`);
      return { success: false, message: `Collection sync failed: ${msg}` };
    }
  }
}
