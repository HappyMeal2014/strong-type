import { Routes } from '@angular/router';
import { Home } from './pages/home/home';
import { Landing } from './pages/landing/landing';

export const routes: Routes = [
  { path: '', component: Landing },
  { path: 'home', component: Home },
];
