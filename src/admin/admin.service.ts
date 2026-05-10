import { Injectable } from '@nestjs/common';
import { UserService } from '../user/user.service';

@Injectable()
export class AdminService {

    constructor(private userService: UserService) { }




      async searchUsers(search: string) {
    return this.userService.searchUser(search);
  }

    }

