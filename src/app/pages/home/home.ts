import { Component } from '@angular/core';
import { LucideChevronDown, LucideMic, LucidePlus, LucideSearch } from '@lucide/angular';

@Component({
  selector: 'app-home',
  imports: [LucidePlus, LucideChevronDown, LucideSearch, LucideMic],
  templateUrl: './home.html',
  styleUrl: './home.css',
})
export class Home {}
