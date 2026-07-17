import { Component, inject } from '@angular/core';
import { Router } from '@angular/router';

@Component({
  selector: 'app-landing',
  imports: [],
  templateUrl: './landing.html',
  styleUrl: './landing.css',
})
export class Landing {
  private readonly router = inject(Router);

  protected getStarted(): void {
    this.router.navigate(['/home']);
  }
}
