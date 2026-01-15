import { Inject, Injectable, OnApplicationBootstrap } from "@nestjs/common";
import {
  LanguageCode,
  Product,
  ProductVariant,
  Collection,
  TransactionalConnection,
  ProcessContext,
  Logger,
} from "@vendure/core";
import { CMS_PLUGIN_OPTIONS } from "../constants";
import { OperationType, PluginInitOptions } from "../types";
import { TranslationUtils } from "../utils/translation.utils";

const DOCUMENT_TYPE = {
  product: "vendureProduct",
  product_variant: "vendureProductVariant",
  collection: "vendureCollection",
};

@Injectable()
export class SanityService implements OnApplicationBootstrap {
  private readonly translationUtils = new TranslationUtils();
  private readonly rateLimitDelay = 20; // ms
  private lastRequestTime = 0;

  private get sanityBaseUrl(): string {
    return `https://${this.options.sanityProjectId}.api.sanity.io/v2025-09-01`;
  }

  constructor(
    private connection: TransactionalConnection,
    private processContext: ProcessContext,
    @Inject(CMS_PLUGIN_OPTIONS) private options: PluginInitOptions,
  ) {}

  async onApplicationBootstrap() {
    // nothing to do for Sanity
  }

  // ---------- PUBLIC SYNC API ----------

  async syncProduct({
    product,
    defaultLanguageCode,
    operationType,
    productSlug,
  }: {
    product: Product;
    defaultLanguageCode: LanguageCode;
    operationType: OperationType;
    productSlug?: string | null;
  }) {
    this.translationUtils.validateTranslations(
      product.translations,
      defaultLanguageCode,
    );

    Logger.info(`Syncing product ${product.id} (${operationType}) to Sanity`);

    switch (operationType) {
      case "create":
        await this.createDocumentFromProduct(
          product,
          defaultLanguageCode,
          productSlug,
        );
        break;
      case "update":
        await this.updateDocumentFromProduct(
          product,
          defaultLanguageCode,
          productSlug,
        );
        break;
      case "delete":
        await this.deleteDocumentFromProduct(product);
        break;
      default:
        Logger.error(`Unknown operation type: ${operationType}`);
    }
  }

  async syncProductVariant({
    variant,
    defaultLanguageCode,
    operationType,
    variantSlug,
    collections,
  }: {
    variant: ProductVariant;
    defaultLanguageCode: LanguageCode;
    operationType: OperationType;
    variantSlug: string;
    collections?: Collection[];
  }) {
    this.translationUtils.validateTranslations(
      variant.translations,
      defaultLanguageCode,
    );

    Logger.info(
      `Syncing product variant ${variant.id} (${operationType}) to Sanity`,
    );

    switch (operationType) {
      case "create":
        await this.createDocumentFromVariant(
          variant,
          defaultLanguageCode,
          variantSlug,
          collections,
        );
        break;
      case "update":
        await this.updateDocumentFromVariant(
          variant,
          defaultLanguageCode,
          variantSlug,
          collections,
        );
        break;
      case "delete":
        await this.deleteDocumentFromVariant(variant);
        break;
      default:
        Logger.error(`Unknown operation type: ${operationType}`);
    }
  }

  async syncCollection({
    collection,
    defaultLanguageCode,
    operationType,
    collectionSlug,
  }: {
    collection: Collection;
    defaultLanguageCode: LanguageCode;
    operationType: OperationType;
    collectionSlug?: string | null;
  }) {
    this.translationUtils.validateTranslations(
      collection.translations,
      defaultLanguageCode,
    );

    Logger.info(
      `Syncing collection ${collection.id} (${operationType}) to Sanity`,
    );

    switch (operationType) {
      case "create":
        await this.createDocumentFromCollection(
          collection,
          defaultLanguageCode,
          collectionSlug,
        );
        break;
      case "update":
        await this.updateDocumentFromCollection(
          collection,
          defaultLanguageCode,
          collectionSlug,
        );
        break;
      case "delete":
        await this.deleteDocumentFromCollection(collection);
        break;
      default:
        Logger.error(`Unknown operation type: ${operationType}`);
    }
  }

  // ---------- LOOKUPS ----------

  private async findDocumentByVendureId(
    vendureId: string | number,
    type: string,
  ): Promise<any | null> {
    try {
      const query = `*[_type == "${type}" && vendureId == ${vendureId}][0]`;
      const response = await this.makeSanityRequest({
        method: "GET",
        endpoint: `data/query/${this.options.sanityDataset || "production"}?query=${encodeURIComponent(query)}`,
      });
      return response.result ?? null;
    } catch (error) {
      Logger.error(
        `Failed to find document by vendure ID: ${vendureId}`,
        String(error),
      );
      return null;
    }
  }

  private async getCollectionDocumentIds(
    collections?: Collection[],
  ): Promise<string[]> {
    if (!collections || collections.length === 0) return [];

    const ids = collections.map((c) => c.id);
    const filter = ids.map((id) => `vendureId == ${id}`).join(" || ");
    const query = `*[_type == "${DOCUMENT_TYPE.collection}" && (${filter})]`;

    try {
      const response = await this.makeSanityRequest({
        method: "GET",
        endpoint: `data/query/${this.options.sanityDataset || "production"}?query=${encodeURIComponent(query)}`,
      });

      const result: any[] = response.result ?? [];
      return result.filter((d) => d?._id).map((d) => d._id as string);
    } catch (error) {
      Logger.error(
        `Failed to resolve collection document IDs for collections: ${ids.join(", ")}`,
        String(error),
      );
      return [];
    }
  }

  private async findParentProductDocumentId(
    variant: ProductVariant,
  ): Promise<string | null> {
    try {
      const product = await this.connection.rawConnection
        .getRepository(Product)
        .findOne({
          where: { id: variant.productId },
          relations: ["translations"],
        });

      if (!product) return null;

      const doc = await this.findDocumentByVendureId(
        product.id,
        DOCUMENT_TYPE.product,
      );
      return doc?._id ?? null;
    } catch (error) {
      Logger.error(
        `Failed to find parent product for variant ${variant.id}`,
        String(error),
      );
      return null;
    }
  }

  // ---------- CREATE / UPDATE / DELETE ----------

  private async createDocumentFromProduct(
    product: Product,
    defaultLanguageCode: LanguageCode,
    productSlug?: string | null,
  ) {
    const data = await this.transformProductData(
      product,
      defaultLanguageCode,
      productSlug,
    );
    if (!data) return;

    const result = await this.makeSanityRequest({
      method: "POST",
      endpoint: `data/mutate/${this.options.sanityDataset || "production"}`,
      data: { mutations: [{ create: data }] },
    });

    Logger.info(
      `Created product ${product.id} in Sanity (ID: ${result.results?.[0]?.id})`,
    );
  }

  private async updateDocumentFromProduct(
    product: Product,
    defaultLanguageCode: LanguageCode,
    productSlug?: string | null,
  ) {
    const existing = await this.findDocumentByVendureId(
      product.id,
      DOCUMENT_TYPE.product,
    );

    if (!existing) {
      Logger.warn(
        `Product ${product.id} not found in Sanity, creating instead of updating`,
      );
      await this.createDocumentFromProduct(
        product,
        defaultLanguageCode,
        productSlug,
      );
      return;
    }

    const data = await this.transformProductData(
      product,
      defaultLanguageCode,
      productSlug,
    );
    if (!data) return;

    await this.makeSanityRequest({
      method: "POST",
      endpoint: `data/mutate/${this.options.sanityDataset || "production"}`,
      data: { mutations: [{ patch: { id: existing._id, set: data } }] },
    });

    Logger.info(
      `Updated product ${product.id} in Sanity (ID: ${existing._id})`,
    );
  }

  private async deleteDocumentFromProduct(product: Product) {
    const existing = await this.findDocumentByVendureId(
      product.id,
      DOCUMENT_TYPE.product,
    );
    if (!existing) {
      Logger.warn(
        `Product ${product.id} not found in Sanity, nothing to delete`,
      );
      return;
    }

    await this.makeSanityRequest({
      method: "POST",
      endpoint: `data/mutate/${this.options.sanityDataset || "production"}`,
      data: { mutations: [{ delete: { id: existing._id } }] },
    });

    Logger.info(`Deleted product ${product.id} from Sanity`);
  }

  private async createDocumentFromVariant(
    variant: ProductVariant,
    defaultLanguageCode: LanguageCode,
    variantSlug: string,
    collections?: Collection[],
  ) {
    const data = await this.transformVariantData(
      variant,
      defaultLanguageCode,
      variantSlug,
      collections,
    );
    if (!data) return;

    const result = await this.makeSanityRequest({
      method: "POST",
      endpoint: `data/mutate/${this.options.sanityDataset || "production"}`,
      data: { mutations: [{ create: data }] },
    });

    Logger.info(
      `Created variant ${variant.id} in Sanity (ID: ${result.results?.[0]?.id})`,
    );
  }

  private async updateDocumentFromVariant(
    variant: ProductVariant,
    defaultLanguageCode: LanguageCode,
    variantSlug: string,
    collections?: Collection[],
  ) {
    const existing = await this.findDocumentByVendureId(
      variant.id,
      DOCUMENT_TYPE.product_variant,
    );

    if (!existing) {
      Logger.warn(
        `Variant ${variant.id} not found in Sanity, creating instead of updating`,
      );
      await this.createDocumentFromVariant(
        variant,
        defaultLanguageCode,
        variantSlug,
        collections,
      );
      return;
    }

    const data = await this.transformVariantData(
      variant,
      defaultLanguageCode,
      variantSlug,
      collections,
    );
    if (!data) return;

    await this.makeSanityRequest({
      method: "POST",
      endpoint: `data/mutate/${this.options.sanityDataset || "production"}`,
      data: { mutations: [{ patch: { id: existing._id, set: data } }] },
    });

    Logger.info(
      `Updated variant ${variant.id} in Sanity (ID: ${existing._id})`,
    );
  }

  private async deleteDocumentFromVariant(variant: ProductVariant) {
    const existing = await this.findDocumentByVendureId(
      variant.id,
      DOCUMENT_TYPE.product_variant,
    );
    if (!existing) {
      Logger.warn(
        `Variant ${variant.id} not found in Sanity, nothing to delete`,
      );
      return;
    }

    await this.makeSanityRequest({
      method: "POST",
      endpoint: `data/mutate/${this.options.sanityDataset || "production"}`,
      data: { mutations: [{ delete: { id: existing._id } }] },
    });

    Logger.info(`Deleted variant ${variant.id} from Sanity`);
  }

  private async createDocumentFromCollection(
    collection: Collection,
    defaultLanguageCode: LanguageCode,
    collectionSlug?: string | null,
  ) {
    const data = await this.transformCollectionData(
      collection,
      defaultLanguageCode,
      collectionSlug,
    );
    if (!data) return;

    const result = await this.makeSanityRequest({
      method: "POST",
      endpoint: `data/mutate/${this.options.sanityDataset || "production"}`,
      data: { mutations: [{ create: data }] },
    });

    Logger.info(
      `Created collection ${collection.id} in Sanity (ID: ${result.results?.[0]?.id})`,
    );
  }

  private async updateDocumentFromCollection(
    collection: Collection,
    defaultLanguageCode: LanguageCode,
    collectionSlug?: string | null,
  ) {
    const existing = await this.findDocumentByVendureId(
      collection.id,
      DOCUMENT_TYPE.collection,
    );

    if (!existing) {
      Logger.warn(
        `Collection ${collection.id} not found in Sanity, creating instead of updating`,
      );
      await this.createDocumentFromCollection(
        collection,
        defaultLanguageCode,
        collectionSlug,
      );
      return;
    }

    const data = await this.transformCollectionData(
      collection,
      defaultLanguageCode,
      collectionSlug,
    );
    if (!data) return;

    await this.makeSanityRequest({
      method: "POST",
      endpoint: `data/mutate/${this.options.sanityDataset || "production"}`,
      data: { mutations: [{ patch: { id: existing._id, set: data } }] },
    });

    Logger.info(
      `Updated collection ${collection.id} in Sanity (ID: ${existing._id})`,
    );
  }

  private async deleteDocumentFromCollection(collection: Collection) {
    const existing = await this.findDocumentByVendureId(
      collection.id,
      DOCUMENT_TYPE.collection,
    );
    if (!existing) {
      Logger.warn(
        `Collection ${collection.id} not found in Sanity, nothing to delete`,
      );
      return;
    }

    await this.makeSanityRequest({
      method: "POST",
      endpoint: `data/mutate/${this.options.sanityDataset || "production"}`,
      data: { mutations: [{ delete: { id: existing._id } }] },
    });

    Logger.info(`Deleted collection ${collection.id} from Sanity`);
  }

  // ---------- TRANSFORMS (NO CYCLES) ----------

  private async transformProductData(
    product: Product,
    defaultLanguageCode: LanguageCode,
    productSlug?: string | null,
  ) {
    const t = this.translationUtils.getTranslationByLanguage(
      product.translations,
      defaultLanguageCode,
    );
    if (!t) {
      Logger.warn(
        `No translation for product ${product.id} in ${defaultLanguageCode}`,
      );
      return undefined;
    }

    const slug =
      productSlug ??
      this.translationUtils.getSlugByLanguage(
        product.translations,
        defaultLanguageCode,
      );

    return {
      _type: DOCUMENT_TYPE.product,
      vendureId: Number(product.id),
      title: t.name,
      slug: { current: slug },
    };
  }

  private async transformVariantData(
    variant: ProductVariant,
    defaultLanguageCode: LanguageCode,
    variantSlug: string,
    collections?: Collection[],
  ) {
    const t = this.translationUtils.getTranslationByLanguage(
      variant.translations,
      defaultLanguageCode,
    );
    if (!t) {
      Logger.warn(
        `No translation for variant ${variant.id} in ${defaultLanguageCode}`,
      );
      return undefined;
    }

    const [parentProductId, collectionIds] = await Promise.all([
      this.findParentProductDocumentId(variant),
      this.getCollectionDocumentIds(collections),
    ]);

    return {
      _type: DOCUMENT_TYPE.product_variant,
      vendureId: Number(variant.id),
      title: t.name,
      slug: { current: variantSlug },
      vendureProduct: parentProductId
        ? { _type: "reference", _ref: parentProductId }
        : undefined,
      vendureCollections: collectionIds.map((id) => ({
        _key: `collection-${id}`,
        _type: "reference",
        _ref: id,
      })),
    };
  }

  private async transformCollectionData(
    collection: Collection,
    defaultLanguageCode: LanguageCode,
    collectionSlug?: string | null,
  ) {
    const t = this.translationUtils.getTranslationByLanguage(
      collection.translations,
      defaultLanguageCode,
    );
    if (!t) {
      Logger.warn(
        `No translation for collection ${collection.id} in ${defaultLanguageCode}`,
      );
      return undefined;
    }

    const slug =
      collectionSlug ??
      this.translationUtils.getSlugByLanguage(
        collection.translations,
        defaultLanguageCode,
      );

    return {
      _type: DOCUMENT_TYPE.collection,
      vendureId: Number(collection.id),
      title: t.name,
      slug: { current: slug },
    };
  }

  // ---------- HTTP + RATE LIMIT ----------

  private getSanityHeaders(): Record<string, string> {
    if (!this.options.sanityApiKey) {
      Logger.error("Sanity API key is not configured");
    }

    return {
      Authorization: `Bearer ${this.options.sanityApiKey}`,
      "Content-Type": "application/json",
    };
  }

  private async enforceRateLimit() {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    const wait = Math.max(0, this.rateLimitDelay - elapsed);
    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    this.lastRequestTime = Date.now();
  }

  private async makeSanityRequest({
    method,
    endpoint,
    data,
  }: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    endpoint: string;
    data?: any;
  }): Promise<any> {
    const url = `${this.sanityBaseUrl}/${endpoint}`;
    const config: RequestInit = {
      method,
      headers: this.getSanityHeaders(),
    };

    if (data && (method === "POST" || method === "PUT")) {
      config.body = JSON.stringify(data);
    }

    await this.enforceRateLimit();

    Logger.debug(`Sanity request: ${method} ${url}`);
    const response = await fetch(url, config);

    if (!response.ok) {
      const text = await response.text();
      const msg = `Sanity API error: ${response.status} ${response.statusText} - ${text}`;
      Logger.error(msg);
      throw new Error(msg);
    }

    if (method === "DELETE") return {};
    return await response.json();
  }
}
