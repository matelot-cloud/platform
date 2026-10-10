import { Module } from '@nestjs/common';
import { CoverageController } from './coverage.controller';
import { CoverageService } from './coverage.service';
import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';
import { OverviewController } from './overview.controller';
import { OverviewService } from './overview.service';

@Module({ controllers: [OverviewController, OnboardingController, CoverageController], providers: [OverviewService, OnboardingService, CoverageService], exports: [CoverageService] })
export class OverviewModule {}
