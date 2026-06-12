import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CostItem } from '../models/costItem.entity';
import { AuditAction, BudgetStatus, CostCategory, CostItemStatus, UserRole } from '../types/enums';
import { CostItemService } from './costItem.service';
import { BudgetService } from './budget.service';
import { AuditLogService } from './auditLog.service';
import { ProjectBudget } from '../models/budget.entity';

const mockContext = {
  requestId: 'test-req-id',
  ip: '127.0.0.1',
  user: { id: 'user-1', role: UserRole.Accountant, name: 'Tester' }
};

const assertFiniteNumber = (value: unknown, field: string): void => {
  expect(value).not.toBeNull();
  expect(value).not.toBeUndefined();
  expect(typeof value).toBe('number');
  expect(Number.isFinite(value as number)).toBe(true);
  expect(Number.isNaN(value as number)).toBe(false);
  expect(value).not.toBe(Infinity);
  expect(value).not.toBe(-Infinity);
};

const assertAutoFlagMetadataAllFinite = (metadata: Record<string, unknown>): void => {
  assertFiniteNumber(metadata.varianceRatio, 'varianceRatio');
  assertFiniteNumber(metadata.threshold, 'threshold');
  if (metadata.budgetAmount !== undefined) {
    assertFiniteNumber(metadata.budgetAmount, 'budgetAmount');
  }
  if (metadata.actualAmount !== undefined) {
    assertFiniteNumber(metadata.actualAmount, 'actualAmount');
  }
};

const makeBudget = (overrides: Partial<ProjectBudget> = {}): ProjectBudget => {
  const budget = new ProjectBudget();
  budget.id = 'budget-1';
  budget.projectId = 'project-1';
  budget.budgetName = '测试预算';
  budget.totalAmount = '100000.00';
  budget.usedAmount = '0.00';
  budget.reservedAmount = '0.00';
  budget.currency = 'CNY' as any;
  budget.status = BudgetStatus.Approved;
  budget.varianceThreshold = null;
  budget.costItems = [];
  budget.remark = null;
  budget.approverId = null;
  budget.approvedAt = null;
  budget.createdAt = new Date();
  budget.updatedAt = new Date();
  return Object.assign(budget, overrides);
};

const makeCostItem = (overrides: Partial<CostItem> = {}): CostItem => {
  const item = new CostItem();
  item.id = 'cost-1';
  item.budgetId = 'budget-1';
  item.category = CostCategory.Material;
  item.costName = '钢筋采购';
  item.budgetAmount = '100000.00';
  item.actualAmount = '100000.00';
  item.varianceAmount = '0.00';
  item.occurredAt = '2026-06-12';
  item.voucherNo = 'V-001';
  item.materialUsageId = null;
  item.laborTimeRecordId = null;
  item.status = CostItemStatus.Normal;
  item.exceptionReason = null;
  item.createdAt = new Date();
  item.updatedAt = new Date();
  return Object.assign(item, overrides);
};

describe('CostItemService', () => {
  let service: CostItemService;
  let budgetService: BudgetService;
  let auditLogService: AuditLogService;
  let costItemRepository: Record<string, jest.Mock>;

  beforeEach(async () => {
    const savedItems: CostItem[] = [];

    costItemRepository = {
      find: jest.fn().mockResolvedValue(savedItems),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((data) => Object.assign(new CostItem(), data)),
      save: jest.fn((item) => {
        const saved = Object.assign(new CostItem(), item, { id: item.id || 'cost-1' });
        savedItems.push(saved);
        return Promise.resolve(saved);
      })
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CostItemService,
        {
          provide: getRepositoryToken(CostItem),
          useValue: costItemRepository
        },
        {
          provide: BudgetService,
          useValue: {
            getById: jest.fn().mockResolvedValue(makeBudget()),
            recalculateUsedAmount: jest.fn().mockResolvedValue(makeBudget())
          }
        },
        {
          provide: AuditLogService,
          useValue: {
            write: jest.fn().mockResolvedValue({})
          }
        }
      ]
    }).compile();

    service = module.get<CostItemService>(CostItemService);
    budgetService = module.get<BudgetService>(BudgetService);
    auditLogService = module.get<AuditLogService>(AuditLogService);
  });

  describe('create', () => {
    const baseInput = {
      budgetId: 'budget-1',
      category: CostCategory.Material,
      costName: '钢筋采购',
      occurredAt: '2026-06-12',
      voucherNo: 'V-001'
    };

    it('should reject when budget is not approved', async () => {
      jest.spyOn(budgetService, 'getById').mockResolvedValue(makeBudget({ status: BudgetStatus.Draft }));
      await expect(
        service.create({ ...baseInput, budgetAmount: 100000, actualAmount: 100000 }, mockContext)
      ).rejects.toThrow(BadRequestException);
    });

    it('should create cost item with Normal status when within threshold', async () => {
      jest.spyOn(budgetService, 'getById').mockResolvedValue(
        makeBudget({ varianceThreshold: '0.1000' })
      );
      const result = await service.create(
        { ...baseInput, budgetAmount: 100000, actualAmount: 105000 },
        mockContext
      );
      expect(result.status).toBe(CostItemStatus.Normal);
      expect(result.exceptionReason).toBeNull();
    });

    it('should auto-flag as Exception when variance exceeds threshold', async () => {
      jest.spyOn(budgetService, 'getById').mockResolvedValue(
        makeBudget({ varianceThreshold: '0.1000' })
      );
      const result = await service.create(
        { ...baseInput, budgetAmount: 100000, actualAmount: 120000 },
        mockContext
      );
      expect(result.status).toBe(CostItemStatus.Exception);
      expect(result.exceptionReason).toContain('实际金额偏离预算比率 20.00% 超过阈值 10.00%');
    });

    it('should write CostItemAutoFlaggedException audit log when auto-flagged', async () => {
      jest.spyOn(budgetService, 'getById').mockResolvedValue(
        makeBudget({ varianceThreshold: '0.1000' })
      );
      await service.create(
        { ...baseInput, budgetAmount: 100000, actualAmount: 120000 },
        mockContext
      );
      const auditCalls = (auditLogService.write as jest.Mock).mock.calls;
      const autoFlaggedCall = auditCalls.find(
        (c: any[]) => c[0].action === AuditAction.CostItemAutoFlaggedException
      );
      expect(autoFlaggedCall).toBeDefined();
      const metadata = autoFlaggedCall![0].metadata as Record<string, unknown>;
      assertAutoFlagMetadataAllFinite(metadata);
      expect(metadata.varianceRatio).toBe(20);
      expect(metadata.threshold).toBe(10);
      expect(metadata.reason).toContain('20.00%');
    });

    it('should not auto-flag when no threshold is set on budget', async () => {
      jest.spyOn(budgetService, 'getById').mockResolvedValue(
        makeBudget({ varianceThreshold: null })
      );
      const result = await service.create(
        { ...baseInput, budgetAmount: 100000, actualAmount: 200000 },
        mockContext
      );
      expect(result.status).toBe(CostItemStatus.Normal);
      expect(result.exceptionReason).toBeNull();
    });

    it('should not write auto-flagged audit log when not flagged', async () => {
      jest.spyOn(budgetService, 'getById').mockResolvedValue(
        makeBudget({ varianceThreshold: '0.1000' })
      );
      await service.create(
        { ...baseInput, budgetAmount: 100000, actualAmount: 105000 },
        mockContext
      );
      const auditCalls = (auditLogService.write as jest.Mock).mock.calls;
      const autoFlaggedCall = auditCalls.find(
        (c: any[]) => c[0].action === AuditAction.CostItemAutoFlaggedException
      );
      expect(autoFlaggedCall).toBeUndefined();
    });

    describe('zero budget edge case', () => {
      it('should auto-flag with readable reason when budget is 0 and actual > 0', async () => {
        jest.spyOn(budgetService, 'getById').mockResolvedValue(
          makeBudget({ varianceThreshold: '0.1000' })
        );
        const result = await service.create(
          { ...baseInput, budgetAmount: 0, actualAmount: 50000 },
          mockContext
        );
        expect(result.status).toBe(CostItemStatus.Exception);
        expect(result.exceptionReason).toContain('预算金额为 0');
        expect(result.exceptionReason).toContain('50000.00');
        expect(result.exceptionReason).not.toContain('Infinity');
        expect(result.exceptionReason).not.toContain('NaN');
        assertFiniteNumber(Number(result.budgetAmount), 'costItem.budgetAmount');
        assertFiniteNumber(Number(result.actualAmount), 'costItem.actualAmount');
        assertFiniteNumber(Number(result.varianceAmount), 'costItem.varianceAmount');
      });

      it('should store finite values in auto-flagged audit metadata for zero budget', async () => {
        jest.spyOn(budgetService, 'getById').mockResolvedValue(
          makeBudget({ varianceThreshold: '0.1000' })
        );
        await service.create(
          { ...baseInput, budgetAmount: 0, actualAmount: 50000 },
          mockContext
        );
        const auditCalls = (auditLogService.write as jest.Mock).mock.calls;
        const autoFlaggedCall = auditCalls.find(
          (c: any[]) => c[0].action === AuditAction.CostItemAutoFlaggedException
        );
        expect(autoFlaggedCall).toBeDefined();
        const metadata = autoFlaggedCall![0].metadata as Record<string, unknown>;
        assertAutoFlagMetadataAllFinite(metadata);
        expect(metadata.varianceRatio).toBe(999.99);
        expect(metadata.threshold).toBe(10);
        expect(metadata.budgetAmount).toBe(0);
        expect(metadata.actualAmount).toBe(50000);
      });

      it('should not auto-flag when budget is 0, actual is 0, and threshold exists', async () => {
        jest.spyOn(budgetService, 'getById').mockResolvedValue(
          makeBudget({ varianceThreshold: '0.1000' })
        );
        const result = await service.create(
          { ...baseInput, budgetAmount: 0, actualAmount: 0 },
          mockContext
        );
        expect(result.status).toBe(CostItemStatus.Normal);
        expect(result.exceptionReason).toBeNull();
        assertFiniteNumber(Number(result.budgetAmount), 'costItem.budgetAmount');
        assertFiniteNumber(Number(result.actualAmount), 'costItem.actualAmount');
      });

      it('should not auto-flag zero-budget overspend when no threshold is set', async () => {
        jest.spyOn(budgetService, 'getById').mockResolvedValue(
          makeBudget({ varianceThreshold: null })
        );
        const result = await service.create(
          { ...baseInput, budgetAmount: 0, actualAmount: 50000 },
          mockContext
        );
        expect(result.status).toBe(CostItemStatus.Normal);
      });

      it('should store finite varianceRatio even with extremely large variance', async () => {
        jest.spyOn(budgetService, 'getById').mockResolvedValue(
          makeBudget({ varianceThreshold: '0.1000' })
        );
        await service.create(
          { ...baseInput, budgetAmount: 1, actualAmount: 1_000_000_000 },
          mockContext
        );
        const auditCalls = (auditLogService.write as jest.Mock).mock.calls;
        const autoFlaggedCall = auditCalls.find(
          (c: any[]) => c[0].action === AuditAction.CostItemAutoFlaggedException
        );
        expect(autoFlaggedCall).toBeDefined();
        const metadata = autoFlaggedCall![0].metadata as Record<string, unknown>;
        assertAutoFlagMetadataAllFinite(metadata);
      });

      it('should store finite threshold in metadata for different precision values', async () => {
        jest.spyOn(budgetService, 'getById').mockResolvedValue(
          makeBudget({ varianceThreshold: '0.0001' })
        );
        await service.create(
          { ...baseInput, budgetAmount: 1000, actualAmount: 2000 },
          mockContext
        );
        const auditCalls = (auditLogService.write as jest.Mock).mock.calls;
        const autoFlaggedCall = auditCalls.find(
          (c: any[]) => c[0].action === AuditAction.CostItemAutoFlaggedException
        );
        expect(autoFlaggedCall).toBeDefined();
        const metadata = autoFlaggedCall![0].metadata as Record<string, unknown>;
        assertAutoFlagMetadataAllFinite(metadata);
        expect(metadata.threshold).toBe(0.01);
        expect(metadata.varianceRatio).toBe(100);
      });
    });
  });

  describe('markException (manual entry preserved)', () => {
    it('should manually mark cost item as Exception with a reason', async () => {
      const existingItem = makeCostItem({ id: 'cost-1', status: CostItemStatus.Normal });
      costItemRepository.findOne.mockResolvedValue(existingItem);

      const result = await service.markException('cost-1', '人工标记原因', mockContext);
      expect(result.status).toBe(CostItemStatus.Exception);
      expect(result.exceptionReason).toBe('人工标记原因');

      const auditCalls = (auditLogService.write as jest.Mock).mock.calls;
      const manualCall = auditCalls.find(
        (c: any[]) => c[0].action === AuditAction.CostItemMarkedException
      );
      expect(manualCall).toBeDefined();
      expect(manualCall![0].metadata.reason).toBe('人工标记原因');
    });
  });

  describe('reviewVariance', () => {
    it('should recalculate variance and mark as VarianceReviewed', async () => {
      const existingItem = makeCostItem({
        id: 'cost-1',
        budgetAmount: '100000.00',
        actualAmount: '120000.00',
        varianceAmount: '0.00'
      });
      costItemRepository.findOne.mockResolvedValue(existingItem);

      const result = await service.reviewVariance('cost-1', mockContext);
      expect(result.status).toBe(CostItemStatus.VarianceReviewed);
      expect(result.varianceAmount).toBe('20000.00');
    });
  });

  describe('getById', () => {
    it('should throw NotFoundException when cost item does not exist', async () => {
      costItemRepository.findOne.mockResolvedValue(null);
      await expect(service.getById('non-existent')).rejects.toThrow(NotFoundException);
    });
  });
});
