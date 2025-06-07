import * as vscode from 'vscode';

export interface Profile {
    name: string;
    instructions: string;
}

export class ProfileManager {
    private static readonly storageKey = 'codelensai.profiles';

    constructor(private readonly context: vscode.ExtensionContext) { }

    public async getProfiles(): Promise<Profile[]> {
        return this.context.globalState.get<Profile[]>(ProfileManager.storageKey, []);
    }

    public async saveProfiles(profiles: Profile[]): Promise<void> {
        return this.context.globalState.update(ProfileManager.storageKey, profiles);
    }

    public async addProfile(profile: Profile): Promise<void> {
        const profiles = await this.getProfiles();
        profiles.push(profile);
        return this.saveProfiles(profiles);
    }

    public async removeProfile(profileName: string): Promise<void> {
        const profiles = await this.getProfiles();
        const updatedProfiles = profiles.filter(p => p.name !== profileName);
        return this.saveProfiles(updatedProfiles);
    }

    public async updateProfile(profileName: string, updatedProfile: Profile): Promise<void> {
        const profiles = await this.getProfiles();
        const index = profiles.findIndex(p => p.name === profileName);
        if (index !== -1) {
            profiles[index] = updatedProfile;
            return this.saveProfiles(profiles);
        }
    }
}