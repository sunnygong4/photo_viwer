import SwiftUI

struct MonthHeaderView: View {
    let month: MonthGroup

    var body: some View {
        HStack {
            Text(month.monthName.uppercased())
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(.secondary)
            Spacer()
            Text(month.totalCount.formatted())
                .font(.system(size: 12))
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.regularMaterial)
    }
}
